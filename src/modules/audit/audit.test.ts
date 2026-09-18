import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { diffRecords, redactMetadata } from './diff';
import { auditRepository } from './repository';
import { AuditLogModel } from './schema';
import { auditService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();
const ACTOR = new mongoose.Types.ObjectId().toHexString();

function ctx(
  estateId = ESTATE_A,
  permissions: string[] = [PERMISSIONS.AUDIT_VIEW],
): RequestContext {
  return {
    userId: ACTOR,
    estateId,
    roles: ['estate-chairman'],
    permissions: new Set(permissions),
    correlationId: 'corr-1',
    ip: '10.0.0.1',
    userAgent: 'test-agent',
    isPlatformAdmin: false,
  };
}

describe('change diffing', () => {
  it('records only fields that actually changed', () => {
    const changes = diffRecords(
      { name: 'Ada', status: 'pending', houseNumber: '12B' },
      { name: 'Ada', status: 'active', houseNumber: '12B' },
    );

    expect(changes).toEqual([{ field: 'status', from: 'pending', to: 'active' }]);
  });

  it('ignores bookkeeping fields', () => {
    expect(
      diffRecords({ updatedAt: new Date(1), __v: 0 }, { updatedAt: new Date(2), __v: 1 }),
    ).toEqual([]);
  });

  // The trail must show THAT a NIN changed without becoming a second database
  // of NINs.
  describe('sensitive fields', () => {
    it('records the fact of a NIN change, never the values', () => {
      const changes = diffRecords({ nin: '12345678901' }, { nin: '99999999999' });

      expect(changes).toEqual([{ field: 'nin', from: '[REDACTED]', to: '[SET]' }]);
      expect(JSON.stringify(changes)).not.toContain('12345678901');
      expect(JSON.stringify(changes)).not.toContain('99999999999');
    });

    it('distinguishes setting from clearing', () => {
      expect(diffRecords({ nin: null }, { nin: 'x' })[0]).toMatchObject({
        from: null,
        to: '[SET]',
      });
      expect(diffRecords({ nin: 'x' }, { nin: null })[0]).toMatchObject({ to: '[CLEARED]' });
    });

    it.each(['password', 'passwordHash', 'twoFactorSecret', 'accountNumber', 'cardNumber'])(
      'redacts %s',
      (field) => {
        const changes = diffRecords({ [field]: 'old-value' }, { [field]: 'new-value' });
        expect(JSON.stringify(changes)).not.toContain('old-value');
        expect(JSON.stringify(changes)).not.toContain('new-value');
      },
    );

    // Storing ciphertext in the audit log is useless and gives it one more
    // place to leak from.
    it('collapses encryption envelopes', () => {
      const changes = diffRecords(
        { secretField: { ct: 'cipher', iv: 'iv', tag: 't', v: 1 } },
        { secretField: { ct: 'other', iv: 'iv2', tag: 't2', v: 1 } },
      );
      expect(JSON.stringify(changes)).not.toContain('cipher');
    });
  });

  it('truncates very long values', () => {
    const change = diffRecords({ notes: 'a' }, { notes: 'b'.repeat(500) })[0]!;
    expect(String(change.to).length).toBeLessThan(250);
  });

  it('treats equal dates and equivalent objects as unchanged', () => {
    expect(diffRecords({ at: new Date(1000) }, { at: new Date(1000) })).toEqual([]);
    expect(diffRecords({ tags: ['a'] }, { tags: ['a'] })).toEqual([]);
  });

  it('redacts metadata by key', () => {
    const result = redactMetadata({ reason: 'lost card', nin: '12345678901' });
    expect(result.reason).toBe('lost card');
    expect(result.nin).toBe('[REDACTED]');
  });
});

describe('writing entries', () => {
  it('records actor, action, resource and request context', async () => {
    await auditService.record(ctx(), {
      action: 'resident.approved',
      resource: 'resident',
      resourceId: 'res-1',
    });

    const entry = await AuditLogModel.findOne().lean();
    expect(entry).toMatchObject({
      action: 'resident.approved',
      resource: 'resident',
      resourceId: 'res-1',
      outcome: 'success',
      actorRoles: ['estate-chairman'],
      ip: '10.0.0.1',
      correlationId: 'corr-1',
    });
  });

  it('derives changes from before and after', async () => {
    await auditService.record(ctx(), {
      action: 'resident.updated',
      resource: 'resident',
      before: { status: 'pending' },
      after: { status: 'active' },
    });

    const entry = await AuditLogModel.findOne().lean();
    expect(entry?.changes).toEqual([{ field: 'status', from: 'pending', to: 'active' }]);
  });

  // Repeated failures are the probing signal worth spotting.
  it('records refused attempts', async () => {
    await auditService.recordFailure(ctx(), {
      action: 'payment.refunded',
      resource: 'payment',
      reason: 'insufficient permissions',
    });

    const entry = await AuditLogModel.findOne().lean();
    expect(entry).toMatchObject({ outcome: 'failure', reason: 'insufficient permissions' });
  });

  // An audit outage must not take the application down with it.
  it('does not throw when writing outside a transaction fails', async () => {
    await expect(
      auditService.record(ctx(), { action: 'x', resource: 'y', metadata: { nin: '1' } }),
    ).resolves.toBeUndefined();
  });
});

describe('immutability', () => {
  // An administrator who can quietly erase evidence of what they did is not an
  // administrator anyone can audit.
  it('refuses updates at the ODM layer', async () => {
    await auditService.record(ctx(), { action: 'resident.approved', resource: 'resident' });
    const entry = await AuditLogModel.findOne().lean();

    await expect(
      AuditLogModel.updateOne({ _id: entry!._id }, { $set: { action: 'nothing.happened' } }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      AuditLogModel.findOneAndUpdate({ _id: entry!._id }, { $set: { action: 'x' } }),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses deletes at the ODM layer', async () => {
    await auditService.record(ctx(), { action: 'resident.approved', resource: 'resident' });

    await expect(AuditLogModel.deleteOne({})).rejects.toThrow(/immutable/i);
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/immutable/i);
  });

  it('exposes no write path on the repository', () => {
    const repository = auditRepository as unknown as Record<string, unknown>;
    for (const method of ['create', 'update', 'updateById', 'delete', 'softDelete', 'hardDelete']) {
      expect(repository[method]).toBeUndefined();
    }
  });

  it('has no updatedAt, which would imply it could be updated', async () => {
    await auditService.record(ctx(), { action: 'a', resource: 'b' });
    const entry = await AuditLogModel.findOne().lean();
    expect(entry).not.toHaveProperty('updatedAt');
    expect(entry?.createdAt).toBeInstanceOf(Date);
  });
});

describe('reading the trail', () => {
  it('requires the audit.view permission', async () => {
    await expect(auditRepository.search(ctx(ESTATE_A, []))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('returns only the calling estate entries', async () => {
    await auditService.record(ctx(ESTATE_A), { action: 'a.happened', resource: 'r' });
    await auditService.record(ctx(ESTATE_B), { action: 'b.happened', resource: 'r' });

    const page = await auditRepository.search(ctx(ESTATE_A));
    expect(page.total).toBe(1);
    expect(page.items[0]?.action).toBe('a.happened');
  });

  it('filters by action, resource and outcome', async () => {
    await auditService.record(ctx(), { action: 'resident.approved', resource: 'resident' });
    await auditService.recordFailure(ctx(), {
      action: 'payment.refunded',
      resource: 'payment',
      reason: 'denied',
    });

    expect((await auditRepository.search(ctx(), { action: 'resident.approved' })).total).toBe(1);
    expect((await auditRepository.search(ctx(), { outcome: 'failure' })).total).toBe(1);
    expect((await auditRepository.search(ctx(), { resource: 'payment' })).total).toBe(1);
  });

  it('returns newest first', async () => {
    await auditService.record(ctx(), { action: 'first.thing', resource: 'r' });
    await new Promise((r) => setTimeout(r, 10));
    await auditService.record(ctx(), { action: 'second.thing', resource: 'r' });

    const page = await auditRepository.search(ctx());
    expect(page.items[0]?.action).toBe('second.thing');
  });

  it('returns the full history of one record, oldest first', async () => {
    await auditService.record(ctx(), {
      action: 'resident.created',
      resource: 'resident',
      resourceId: 'r1',
    });
    await new Promise((r) => setTimeout(r, 10));
    await auditService.record(ctx(), {
      action: 'resident.approved',
      resource: 'resident',
      resourceId: 'r1',
    });
    await auditService.record(ctx(), {
      action: 'resident.created',
      resource: 'resident',
      resourceId: 'r2',
    });

    const history = await auditRepository.historyFor(ctx(), 'resident', 'r1');
    expect(history.map((e) => e.action)).toEqual(['resident.created', 'resident.approved']);
  });

  it('caps page size', async () => {
    expect((await auditRepository.search(ctx(), {}, { limit: 100_000 })).limit).toBe(100);
  });

  it('reports another estate entry as not found', async () => {
    await auditService.record(ctx(ESTATE_B), { action: 'b.happened', resource: 'r' });
    const entry = await AuditLogModel.findOne().lean();

    await expect(
      auditRepository.findById(ctx(ESTATE_A), entry!._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
