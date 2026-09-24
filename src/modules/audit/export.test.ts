/**
 * Exporting the audit trail.
 *
 * The property that matters most is not that the export works — it is that the
 * export cannot be used to recover what the trail deliberately redacted on the
 * way in. `audit.export` must not be a back door around `diffRecords`.
 */
import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from './service';
import { auditExportService } from './export.service';
import { AuditLogModel } from './schema';

setupTestDatabase();

const estateId = new Types.ObjectId().toHexString();

function ctx(permissions: string[], estate = estateId): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId: estate,
    roles: ['estate-chairman'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    ip: '203.0.113.9',
    isPlatformAdmin: false,
  };
}

const FULL = [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT];
const range = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date() });

describe('the export permission is a real gate', () => {
  it('refuses a caller with audit.view but not audit.export', async () => {
    await expect(auditExportService.export(ctx([PERMISSIONS.AUDIT_VIEW]), range())).rejects.toThrow(
      /audit\.export/,
    );
  });

  it('refuses a caller with audit.export but not audit.view', async () => {
    await expect(
      auditExportService.export(ctx([PERMISSIONS.AUDIT_EXPORT]), range()),
    ).rejects.toThrow(/audit\.view/);
  });

  /**
   * The most interesting line the trail can hold: somebody without the
   * permission trying to take the evidence out of the system.
   */
  it('records the refusal in the trail before throwing', async () => {
    await expect(
      auditExportService.export(ctx([PERMISSIONS.AUDIT_VIEW]), range()),
    ).rejects.toThrow();

    const denied = await AuditLogModel.findOne({ action: 'audit.export.denied' }).lean();
    expect(denied).toBeTruthy();
    expect(denied!.outcome).toBe('failure');
    expect(denied!.reason).toContain('audit.export');
  });
});

describe('what the file contains', () => {
  it('does not leak the values the trail redacted', async () => {
    const context = ctx(FULL);

    // The trail records THAT a NIN changed, never its value. An export that
    // flattened `changes` into cells would carry the surrounding values out in
    // bulk; this one emits field names only.
    await auditService.record(context, {
      action: 'resident.updated',
      resource: 'user',
      resourceId: 'abc',
      before: { nin: '12345678901', firstName: 'Ada' },
      after: { nin: '98765432109', firstName: 'Adaeze' },
    });

    const file = await auditExportService.export(context, range());

    // The stored entry is already redacted...
    const stored = await AuditLogModel.findOne({ action: 'resident.updated' }).lean();
    expect(JSON.stringify(stored!.changes)).not.toContain('12345678901');

    // ...and the export carries neither the redacted marker's neighbours nor
    // any before/after value at all — only the names of the fields that moved.
    expect(file.body).not.toContain('12345678901');
    expect(file.body).not.toContain('98765432109');
    expect(file.body).not.toContain('Adaeze');
    expect(file.body).toContain('nin');
    expect(file.body).toContain('firstName');
  });

  it('does not carry metadata values out', async () => {
    const context = ctx(FULL);

    await auditService.record(context, {
      action: 'visitor.admitted',
      resource: 'visitor',
      resourceId: 'v1',
      metadata: { plate: 'ABC-123-XY', hostAddress: '12B Palm Avenue' },
    });

    const file = await auditExportService.export(context, range());

    expect(file.rowCount).toBe(1);
    expect(file.body).not.toContain('ABC-123-XY');
    expect(file.body).not.toContain('Palm Avenue');
  });

  it('writes a spreadsheet Excel can open', async () => {
    const context = ctx(FULL);
    await auditService.record(context, { action: 'gate.scanned', resource: 'gate' });

    const file = await auditExportService.export(context, range());

    expect(file.body.startsWith('﻿')).toBe(true);
    expect(file.body).toContain('\r\n');
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.filename).toMatch(/^audit-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('neutralises a refusal reason that begins with an equals sign', async () => {
    const context = ctx(FULL);

    await auditService.recordFailure(context, {
      action: 'gate.scan.denied',
      resource: 'gate',
      reason: '=HYPERLINK("http://evil.example","click")',
    });

    const file = await auditExportService.export(context, range());

    expect(file.body).toContain("'=HYPERLINK");
  });
});

describe('scoping and bounds', () => {
  it('cannot read another estate’s trail', async () => {
    const owner = ctx(FULL);
    await auditService.record(owner, { action: 'estate.updated', resource: 'estate' });

    const stranger = ctx(FULL, new Types.ObjectId().toHexString());
    const file = await auditExportService.export(stranger, range());

    // Only the stranger's own refusal-free export exists; the owner's entry is
    // not in it.
    expect(file.body).not.toContain('estate.updated');
  });

  it('refuses a range wider than a year', async () => {
    await expect(
      auditExportService.export(ctx(FULL), {
        from: new Date('2020-01-01'),
        to: new Date('2026-01-01'),
      }),
    ).rejects.toThrow(/at most 366 days/);
  });

  it('narrows to one action when asked', async () => {
    const context = ctx(FULL);
    await auditService.record(context, { action: 'gate.scanned', resource: 'gate' });
    await auditService.record(context, { action: 'resident.approved', resource: 'membership' });

    const file = await auditExportService.export(context, {
      ...range(),
      action: 'gate.scanned',
    });

    expect(file.body).toContain('gate.scanned');
    expect(file.body).not.toContain('resident.approved');
  });

  it('records the export itself', async () => {
    const context = ctx(FULL);
    await auditExportService.export(context, range());

    const entry = await AuditLogModel.findOne({ action: 'audit.exported' }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.outcome).toBe('success');
  });
});
