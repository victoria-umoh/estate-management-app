/**
 * Reports and exports.
 *
 * The interesting behaviour is not the arithmetic — it is the boundaries. A
 * report aggregates whole collections, so the two things that must hold are
 * that it never totals another estate's rows into this estate's figures, and
 * that reading a report on screen is not the same permission as carrying it
 * out of the building as a file.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { InvoiceModel, PaymentModel } from '@/modules/finance/schema';
import { GateModel } from '@/modules/gate/schema';
import { IncidentModel } from '@/modules/incident/schema';
import { MembershipModel } from '@/modules/membership/schema';
import { MovementModel } from '@/modules/movement/schema';
import { UserModel } from '@/modules/user/schema';
import { VisitorPassModel } from '@/modules/visitor/schema';
import { tableToCsv } from './csv';
import { reportService } from './service';
import { EXPORT_ROW_LIMIT, type ReportTable } from './types';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId();
const ESTATE_B = new mongoose.Types.ObjectId();

const RANGE = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-03-31T23:59:59.000Z'),
};

function ctx(permissions: string[], estateId = ESTATE_A): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId: estateId.toHexString(),
    roles: ['estate-manager'],
    permissions: new Set(permissions),
    correlationId: 'corr-report',
    isPlatformAdmin: false,
  };
}

const READ_ALL = [
  PERMISSIONS.REPORT_VIEW,
  PERMISSIONS.REPORT_GENERATE,
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.LEDGER_VIEW,
  PERMISSIONS.GATE_LOG_VIEW,
  PERMISSIONS.RESIDENT_VIEW,
  PERMISSIONS.INCIDENT_VIEW_ALL,
  PERMISSIONS.VISITOR_VIEW,
];

const EXPORT_ALL = [
  ...READ_ALL,
  PERMISSIONS.REPORT_EXPORT,
  PERMISSIONS.LEDGER_EXPORT,
  PERMISSIONS.GATE_LOG_EXPORT,
  PERMISSIONS.RESIDENT_EXPORT,
];

async function makeMember(estateId = ESTATE_A, overrides: Record<string, unknown> = {}) {
  const email = `u${Math.random().toString(36).slice(2)}@example.com`;
  const user = await UserModel.create({
    firstName: 'Ada',
    lastName: 'Okonkwo',
    email,
    phone: `+23480${Math.floor(Math.random() * 100000000)}`,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(`${Math.random()}`, 'phone'),
    passwordHash: 'x',
    status: 'active',
    // Present in the database, and required never to reach an export.
    ninLast4: '4321',
  });

  return MembershipModel.create({
    estateId,
    userId: user._id,
    category: 'tenant',
    status: 'active',
    residentCode: `R-${Math.random().toString(36).slice(2, 8)}`,
    movedInAt: new Date('2026-02-10T00:00:00.000Z'),
    ...overrides,
  });
}

async function makeInvoice(
  estateId: mongoose.Types.ObjectId,
  membershipId: mongoose.Types.ObjectId,
  total: number,
  paid: number,
) {
  return InvoiceModel.create({
    estateId,
    number: `INV-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    membershipId,
    lines: [{ description: 'Service charge', quantity: 1, unitAmount: total, lineTotal: total }],
    subtotal: total,
    total,
    amountPaid: paid,
    status: paid >= total ? 'paid' : 'issued',
    issuedAt: new Date('2026-02-01T00:00:00.000Z'),
    dueAt: new Date('2026-02-28T00:00:00.000Z'),
  });
}

async function makeMovement(
  estateId: mongoose.Types.ObjectId,
  admitted: boolean,
  gateId: mongoose.Types.ObjectId,
) {
  return MovementModel.create({
    estateId,
    gateId,
    officerId: new mongoose.Types.ObjectId(),
    direction: 'in',
    subject: 'visitor',
    subjectLabel: 'Chidi, a guest',
    admitted,
    method: 'qr',
    occurredAt: new Date('2026-02-14T09:30:00.000Z'),
  });
}

let memberA: Awaited<ReturnType<typeof makeMember>>;
let gateA: mongoose.Types.ObjectId;

beforeEach(async () => {
  memberA = await makeMember();
  const gate = await GateModel.create({ estateId: ESTATE_A, name: 'Main Gate', code: 'MAIN' });
  gateA = gate._id;

  await makeInvoice(ESTATE_A, memberA._id, 50_000_00, 20_000_00);
  await makeInvoice(ESTATE_A, memberA._id, 10_000_00, 10_000_00);

  await PaymentModel.create({
    estateId: ESTATE_A,
    reference: `PAY-${Math.random().toString(36).slice(2, 12)}`,
    membershipId: memberA._id,
    amount: 30_000_00,
    provider: 'manual',
    status: 'successful',
    providerFee: 150_00,
    paidAt: new Date('2026-02-05T00:00:00.000Z'),
  });

  await makeMovement(ESTATE_A, true, gateA);
  await makeMovement(ESTATE_A, false, gateA);

  await IncidentModel.create({
    estateId: ESTATE_A,
    reference: 'INC-0001',
    category: 'theft',
    severity: 'critical',
    severityRank: 4,
    title: 'Bicycle taken from block C',
    description: 'A long narrative that has no business being in a spreadsheet.',
    reportedByMembershipId: memberA._id,
    occurredAt: new Date('2026-02-01T00:00:00.000Z'),
    // Ten hours against a four-hour critical target: a breach.
    resolvedAt: new Date('2026-02-01T10:00:00.000Z'),
    status: 'resolved',
  });

  await VisitorPassModel.create({
    estateId: ESTATE_A,
    code: 'ABC123',
    hostMembershipId: memberA._id,
    visitorName: 'Chidi Eze',
    purpose: 'Family visit',
    partySize: 2,
    expectedArrival: new Date('2026-02-14T09:00:00.000Z'),
    expectedDeparture: new Date('2026-02-14T12:00:00.000Z'),
    checkedInAt: new Date('2026-02-14T09:30:00.000Z'),
    checkedOutAt: new Date('2026-02-14T15:00:00.000Z'),
    status: 'completed',
    issuedBy: new mongoose.Types.ObjectId(),
  });
});

function table(tables: ReportTable[], id: string): ReportTable {
  const found = tables.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No table "${id}" in [${tables.map((t) => t.id).join(', ')}]`);
  return found;
}

function stat(summary: Array<{ key: string; value: unknown }>, key: string): unknown {
  return summary.find((entry) => entry.key === key)?.value;
}

describe('collections', () => {
  it('totals what was invoiced, collected and left outstanding', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'collections', RANGE);

    expect(stat(report.summary, 'invoiced')).toBe(60_000_00);
    expect(stat(report.summary, 'outstanding')).toBe(30_000_00);
    expect(stat(report.summary, 'collected')).toBe(30_000_00);
    expect(stat(report.summary, 'collectionRate')).toBe(50);
    expect(table(report.tables, 'detail').rows).toHaveLength(2);
  });

  it('leaves another estate out of the totals', async () => {
    const otherMember = await makeMember(ESTATE_B);
    await makeInvoice(ESTATE_B, otherMember._id, 99_999_00, 0);

    const report = await reportService.run(ctx(READ_ALL), 'collections', RANGE);

    expect(stat(report.summary, 'invoiced')).toBe(60_000_00);
    expect(table(report.tables, 'detail').rows).toHaveLength(2);
  });
});

describe('gate activity', () => {
  it('counts admissions and denials, and names the busiest gate', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'gate-activity', RANGE);

    expect(stat(report.summary, 'total')).toBe(2);
    expect(stat(report.summary, 'entries')).toBe(1);
    expect(stat(report.summary, 'denied')).toBe(1);
    expect(stat(report.summary, 'denialRate')).toBe(50);
    expect(stat(report.summary, 'busiestGate')).toBe('Main Gate (MAIN)');
  });

  it('does not count another estate’s movements', async () => {
    const otherGate = await GateModel.create({ estateId: ESTATE_B, name: 'Gate', code: 'G' });
    await makeMovement(ESTATE_B, true, otherGate._id);

    const report = await reportService.run(ctx(READ_ALL), 'gate-activity', RANGE);
    expect(stat(report.summary, 'total')).toBe(2);
  });
});

describe('incidents', () => {
  it('measures time to resolve and counts a breach of the severity target', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'incidents', RANGE);

    expect(stat(report.summary, 'total')).toBe(1);
    expect(stat(report.summary, 'meanHours')).toBe(10);
    expect(stat(report.summary, 'breaches')).toBe(1);
    expect(table(report.tables, 'detail').rows[0]?.targetHours).toBe(4);
  });

  it('keeps the narrative out of the exportable rows', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'incidents', RANGE);
    const columns = table(report.tables, 'detail').columns.map((column) => column.key);

    expect(columns).toContain('title');
    expect(columns).not.toContain('description');
  });
});

describe('visitors', () => {
  it('rates an overstay against the visitors who actually arrived', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'visitors', RANGE);

    expect(stat(report.summary, 'total')).toBe(1);
    expect(stat(report.summary, 'arrived')).toBe(1);
    expect(stat(report.summary, 'overstayRate')).toBe(100);
    expect(stat(report.summary, 'guests')).toBe(2);
  });

  it('never publishes the gate code a pass is verified with', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'visitors', RANGE);
    const detail = table(report.tables, 'detail');

    expect(detail.columns.map((column) => column.key)).not.toContain('code');
    expect(JSON.stringify(detail.rows)).not.toContain('ABC123');
  });
});

describe('residents', () => {
  it('counts the roster and the move-ins within the range', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'residents', RANGE);

    expect(stat(report.summary, 'active')).toBe(1);
    expect(stat(report.summary, 'moveIns')).toBe(1);
  });

  // The rule that matters most: identity data does not travel in a spreadsheet.
  it('excludes identity and contact fields from the export', async () => {
    const file = await reportService.export(ctx(EXPORT_ALL), 'residents', RANGE, {
      tableId: 'detail',
    });

    expect(file.body).toContain('Resident code');
    expect(file.body).toContain('Ada Okonkwo');
    expect(file.body).not.toContain('4321');
    expect(file.body.toLowerCase()).not.toContain('@example.com');
    expect(file.body.toLowerCase()).not.toContain('nin');
  });
});

describe('analytics tables', () => {
  it('withholds the trends from a caller without analytics.view, and says so', async () => {
    const report = await reportService.run(
      ctx(READ_ALL.filter((permission) => permission !== PERMISSIONS.ANALYTICS_VIEW)),
      'collections',
      RANGE,
    );

    expect(report.tables.map((entry) => entry.id)).not.toContain('by-month');
    expect(report.withheldTables).toContain('By month');
    // The rest of the report still arrives — the point of the split.
    expect(report.tables.map((entry) => entry.id)).toContain('detail');
  });
});

describe('export permissions', () => {
  // The estate-manager role really is defined this way: gateLog.view without
  // gateLog.export. Reading the gate log on screen and carrying it out as a
  // file are different acts.
  it('refuses an export to a caller who may only read the report', async () => {
    const viewer = ctx([...READ_ALL, PERMISSIONS.REPORT_EXPORT]);

    await expect(reportService.run(viewer, 'gate-activity', RANGE)).resolves.toBeTruthy();

    await expect(
      reportService.export(viewer, 'gate-activity', RANGE, { tableId: 'detail' }),
    ).rejects.toThrow(/gateLog.export/);
  });

  it('refuses an export to a caller without report.export at all', async () => {
    await expect(
      reportService.export(ctx(READ_ALL), 'collections', RANGE, { tableId: 'detail' }),
    ).rejects.toThrow(/report.export/);
  });

  it('records the refusal in the audit trail', async () => {
    await reportService
      .export(ctx(READ_ALL), 'collections', RANGE, { tableId: 'detail' })
      .catch(() => undefined);

    const entry = await AuditLogModel.findOne({ action: 'report.export.denied' }).lean();

    expect(entry?.outcome).toBe('failure');
    expect(entry?.resourceId).toBe('collections');
    expect(entry?.reason).toContain('report.export');
  });

  it('records a successful export with who, what and the range', async () => {
    const actor = ctx(EXPORT_ALL);
    await reportService.export(actor, 'collections', RANGE, { tableId: 'detail' });

    const entry = await AuditLogModel.findOne({ action: 'report.exported' }).lean();

    expect(entry?.actorLabel).toBe(actor.userId);
    expect(entry?.resourceId).toBe('collections');
    expect(entry?.metadata).toMatchObject({
      report: 'collections',
      table: 'detail',
      format: 'csv',
      rows: 2,
      truncated: false,
    });
    expect(String(entry?.metadata?.from)).toBe(RANGE.from.toISOString());
  });

  it('lists only the reports a caller may run', async () => {
    const catalogue = reportService.catalogue(ctx([PERMISSIONS.GATE_LOG_VIEW]));
    const gate = catalogue.find((entry) => entry.type === 'gate-activity');

    expect(gate?.canView).toBe(true);
    expect(gate?.canExport).toBe(false);
    expect(catalogue.find((entry) => entry.type === 'collections')?.canView).toBe(false);
  });
});

describe('ranges', () => {
  it('rejects a range that ends before it starts', async () => {
    await expect(
      reportService.run(ctx(READ_ALL), 'collections', { from: RANGE.to, to: RANGE.from }),
    ).rejects.toThrow(/before its start/);
  });

  it('refuses more than a year in one report', async () => {
    await expect(
      reportService.run(ctx(READ_ALL), 'collections', {
        from: new Date('2020-01-01T00:00:00.000Z'),
        to: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/at most 366 days/);
  });
});

describe('row caps', () => {
  it('marks a table truncated rather than quietly serving a short file', async () => {
    const report = await reportService.run(ctx(READ_ALL), 'collections', RANGE, { rowLimit: 1 });
    const detail = table(report.tables, 'detail');

    expect(detail.rows).toHaveLength(1);
    expect(detail.totalRows).toBe(2);
    expect(detail.truncated).toBe(true);
  });

  it('caps an export well below what would exhaust memory', () => {
    expect(EXPORT_ROW_LIMIT).toBeLessThanOrEqual(50_000);
  });
});

describe('CSV', () => {
  const sample: ReportTable = {
    id: 'detail',
    label: 'Detail',
    columns: [
      { key: 'name', label: 'Name', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'money' },
    ],
    rows: [
      { name: 'Okonkwo, Ada', amount: 12_345_67 },
      { name: 'She said "hello"', amount: 0 },
      { name: '=SUM(A1:A9)', amount: null },
    ],
    totalRows: 3,
    truncated: false,
  };

  const csv = tableToCsv(sample, { notes: ['Range: 2026-01-01 to 2026-03-31'] });

  it('opens correctly in Excel: BOM, CRLF and a currency-labelled header', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('Amount (NGN)');
  });

  it('quotes a field containing a comma and doubles an embedded quote', () => {
    expect(csv).toContain('"Okonkwo, Ada"');
    expect(csv).toContain('"She said ""hello"""');
  });

  // Without this, a value beginning with `=` becomes a live formula in
  // whichever spreadsheet the file is eventually opened in.
  it('neutralises a cell Excel would evaluate as a formula', () => {
    expect(csv).toContain("'=SUM(A1:A9)");
  });

  it('renders minor units as major units so the column sums correctly', () => {
    expect(csv).toContain('12345.67');
  });
});
