import type { PipelineStage } from 'mongoose';
import { BaseRepository } from '@/core/db';
import { UnprocessableError, ValidationError } from '@/core/errors';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { estateRepository } from '@/modules/estate';
import {
  FeeCategoryModel,
  InvoiceModel,
  PaymentModel,
  type FeeCategoryDoc,
  type InvoiceDoc,
  type PaymentDoc,
} from '@/modules/finance/schema';
import { GateModel, type GateDoc } from '@/modules/gate/schema';
import { IncidentModel, type IncidentDoc } from '@/modules/incident/schema';
import { MembershipModel, type MembershipDoc } from '@/modules/membership/schema';
import { MovementModel, type MovementDoc } from '@/modules/movement/schema';
import { VisitorPassModel, type VisitorPassDoc } from '@/modules/visitor/schema';
import { exportFilename, tableToCsv } from './csv';
import {
  EXPORT_ROW_LIMIT,
  INCIDENT_SLA_HOURS,
  PREVIEW_ROW_LIMIT,
  REPORT_REGISTRY,
  type ExportFormat,
  type ReportColumn,
  type ReportDescriptor,
  type ReportResult,
  type ReportRow,
  type ReportStat,
  type ReportTable,
  type ReportType,
} from './types';

/**
 * Reports and exports.
 *
 * Two things shape everything here.
 *
 * The first is that a report is not one permission. Following the dashboard,
 * the caller is asked what they may see and is given that — so `report.view`
 * lists the reports a role can actually run rather than all five, and a
 * caller without `analytics.view` still gets their report, minus the trend
 * tables. Refusing the whole screen because one block is out of reach is how
 * a page nobody can open gets built.
 *
 * The second is that every aggregation goes through a repository, never
 * through a model. `BaseRepository.aggregate` forces `estateId` into the FIRST
 * pipeline stage; a report is precisely the place where a missing tenant
 * filter does not leak one record but every record, already totalled and
 * formatted for convenience.
 */

class InvoiceReportRepository extends BaseRepository<InvoiceDoc> {
  constructor() {
    super(InvoiceModel);
  }
}
class PaymentReportRepository extends BaseRepository<PaymentDoc> {
  constructor() {
    super(PaymentModel);
  }
}
class FeeReportRepository extends BaseRepository<FeeCategoryDoc> {
  constructor() {
    super(FeeCategoryModel);
  }
}
class MovementReportRepository extends BaseRepository<MovementDoc> {
  constructor() {
    super(MovementModel);
  }
}
class MembershipReportRepository extends BaseRepository<MembershipDoc> {
  constructor() {
    super(MembershipModel);
  }
}
class IncidentReportRepository extends BaseRepository<IncidentDoc> {
  constructor() {
    super(IncidentModel);
  }
}
class VisitorReportRepository extends BaseRepository<VisitorPassDoc> {
  constructor() {
    super(VisitorPassModel);
  }
}
class GateReportRepository extends BaseRepository<GateDoc> {
  constructor() {
    super(GateModel);
  }
}

const invoices = new InvoiceReportRepository();
const payments = new PaymentReportRepository();
const fees = new FeeReportRepository();
const movements = new MovementReportRepository();
const memberships = new MembershipReportRepository();
const incidents = new IncidentReportRepository();
const visitors = new VisitorReportRepository();
const gates = new GateReportRepository();

export interface ReportRange {
  from: Date;
  to: Date;
}

export interface ExportedReport {
  filename: string;
  contentType: string;
  body: string;
  rowCount: number;
  totalRows: number;
  truncated: boolean;
}

/**
 * Widest range a single report may cover.
 *
 * Not a performance guess: an unbounded `from` turns every one of these into a
 * full collection scan, and the movement log is the largest collection the
 * platform has. A year at a time is what a committee actually asks for.
 */
const MAX_RANGE_DAYS = 366;

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * A missing cell stays missing.
 *
 * The screen renders null as an em dash; the CSV renders it as an empty field.
 * Substituting the dash here would put a punctuation mark into a spreadsheet
 * column someone is about to sort or filter on.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `$avg` over nothing is null, and a mean of zero would read as "instantly". */
function meanOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? round1(value) : null;
}

/**
 * Build a table from a faceted aggregation.
 *
 * Every detail table is capped, and the cap is carried on the table itself
 * rather than inferred from the row count — a page that happens to be exactly
 * the limit long is not the same as a page that was cut short, and only the
 * former is safe to present as complete.
 */
function makeTable(
  id: string,
  label: string,
  columns: ReportColumn[],
  rows: ReportRow[],
  totalRows: number,
): ReportTable {
  return { id, label, columns, rows, totalRows, truncated: rows.length < totalRows };
}

interface Facet<T> {
  rows?: T[];
  total?: Array<{ n: number }>;
}

/**
 * One pass that returns a capped page and the full count.
 *
 * `$limit` goes in BEFORE the joins, not after. A detail table sorts, takes
 * its two hundred rows and only then looks up unit numbers; the other way
 * round, a year of an estate's movement log would run a join per row and
 * throw almost all of it away.
 */
function facet(
  order: PipelineStage.FacetPipelineStage[],
  limit: number,
  afterLimit: PipelineStage.FacetPipelineStage[] = [],
): PipelineStage {
  return {
    $facet: {
      rows: [...order, { $limit: limit }, ...afterLimit],
      total: [{ $count: 'n' }],
    },
  } as PipelineStage;
}

function unpackFacet<T>(result: Array<Facet<T>>): { rows: T[]; total: number } {
  const first = result[0];
  return { rows: first?.rows ?? [], total: first?.total?.[0]?.n ?? 0 };
}

export class ReportService {
  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------

  /**
   * The reports this caller may run.
   *
   * Returned per caller rather than as a fixed list, so the screen offers a
   * security administrator gate activity and incidents and does not dangle a
   * collections report that would 403 on click.
   */
  catalogue(
    context: RequestContext,
  ): Array<ReportDescriptor & { canView: boolean; canExport: boolean }> {
    return Object.values(REPORT_REGISTRY).map((descriptor) => ({
      ...descriptor,
      canView: can(context, descriptor.viewPermission),
      canExport:
        can(context, PERMISSIONS.REPORT_EXPORT) && can(context, descriptor.exportPermission),
    }));
  }

  // -------------------------------------------------------------------------
  // Running a report
  // -------------------------------------------------------------------------

  async run(
    context: RequestContext,
    type: ReportType,
    range: ReportRange,
    options: { rowLimit?: number; tableId?: string } = {},
  ): Promise<ReportResult> {
    const descriptor = REPORT_REGISTRY[type];
    assertCan(context, descriptor.viewPermission);

    const { from, to } = this.assertRange(range);
    const rowLimit = options.rowLimit ?? PREVIEW_ROW_LIMIT;
    const timezone = await this.timezone(context);

    const built = await this.build(context, type, { from, to }, rowLimit, timezone);

    // Trend tables are the analytics view of the same data. A caller without
    // `analytics.view` still gets the report; the withheld tables are named so
    // they can ask for the permission rather than assume the report is broken.
    const analytics = can(context, PERMISSIONS.ANALYTICS_VIEW);
    const visible = analytics ? built.tables : built.tables.filter((t) => !t.trend);
    const withheld = analytics ? [] : built.tables.filter((t) => t.trend).map((t) => t.table.label);

    const selected = options.tableId
      ? visible.filter((t) => t.table.id === options.tableId)
      : visible;

    if (options.tableId && selected.length === 0) {
      throw new UnprocessableError(
        `This report has no table "${options.tableId}" available to you.`,
      );
    }

    return {
      type,
      title: descriptor.title,
      description: descriptor.description,
      range: { from: from.toISOString(), to: to.toISOString() },
      generatedAt: new Date().toISOString(),
      summary: built.summary,
      tables: selected.map((t) => t.table),
      withheldTables: withheld,
      exportable:
        can(context, PERMISSIONS.REPORT_EXPORT) && can(context, descriptor.exportPermission),
    };
  }

  // -------------------------------------------------------------------------
  // Exporting
  // -------------------------------------------------------------------------

  /**
   * Export one table of one report.
   *
   * Gated twice and deliberately: `report.export` says this person may take
   * data out at all, and the report's own export permission says they may take
   * out THIS data. An estate manager holds `gateLog.view` and not
   * `gateLog.export` — they may read the gate activity on screen and may not
   * carry the movement log out as a file, and that is the whole point of the
   * split.
   *
   * Every attempt lands in the audit trail, refusals included, because a
   * pattern of refused exports is the signal worth having.
   */
  async export(
    context: RequestContext,
    type: ReportType,
    range: ReportRange,
    options: { tableId: string; format?: ExportFormat },
  ): Promise<ExportedReport> {
    const descriptor = REPORT_REGISTRY[type];
    const format = options.format ?? 'csv';

    if (format !== 'csv') {
      throw new UnprocessableError(
        'Only CSV export is available. The file is UTF-8 with a byte-order mark and opens directly in Excel.',
      );
    }

    for (const permission of [PERMISSIONS.REPORT_EXPORT, descriptor.exportPermission]) {
      if (!can(context, permission)) {
        await auditService.recordFailure(context, {
          action: 'report.export.denied',
          resource: 'report',
          resourceId: type,
          reason: `Missing "${permission}".`,
          metadata: {
            report: type,
            table: options.tableId,
            from: range.from.toISOString(),
            to: range.to.toISOString(),
          },
        });
      }
      assertCan(context, permission);
    }

    // Viewing is still required: export is an additional act, not a substitute
    // for being allowed to see the thing at all.
    assertCan(context, descriptor.viewPermission);

    const { from, to } = this.assertRange(range);
    const timezone = await this.timezone(context);

    const built = await this.build(context, type, { from, to }, EXPORT_ROW_LIMIT, timezone);
    const analytics = can(context, PERMISSIONS.ANALYTICS_VIEW);

    const found = built.tables.find(
      (candidate) => candidate.table.id === options.tableId && (analytics || !candidate.trend),
    );

    if (!found) {
      throw new UnprocessableError(`This report has no table "${options.tableId}".`);
    }

    const table = found.table;

    const body = tableToCsv(table, {
      notes: [
        `${descriptor.title} — ${table.label}`,
        `Range: ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)} (${timezone})`,
        `Exported by ${context.userId} at ${new Date().toISOString()}`,
        'Contains no identity numbers. Request an audited single-record lookup if you need one.',
      ],
    });

    await auditService.record(context, {
      action: 'report.exported',
      resource: 'report',
      resourceId: type,
      metadata: {
        report: type,
        table: table.id,
        format,
        from: from.toISOString(),
        to: to.toISOString(),
        rows: table.rows.length,
        totalRows: table.totalRows,
        truncated: table.truncated,
      },
    });

    return {
      filename: exportFilename(type, table.id, from, to),
      // charset is stated so Excel honours the BOM rather than guessing.
      contentType: 'text/csv; charset=utf-8',
      body,
      rowCount: table.rows.length,
      totalRows: table.totalRows,
      truncated: table.truncated,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertRange(range: ReportRange): ReportRange {
    const { from, to } = range;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ValidationError('The report range is not a valid pair of dates.');
    }
    if (to.getTime() < from.getTime()) {
      throw new ValidationError('The end of the report range falls before its start.');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * HOUR_MS) {
      throw new UnprocessableError(
        `A report may cover at most ${MAX_RANGE_DAYS} days. Narrow the range and run it again.`,
      );
    }

    return { from, to };
  }

  /** The estate's own timezone, so "by day" means their day and not UTC's. */
  private async timezone(context: RequestContext): Promise<string> {
    const estate = await estateRepository.findById(context.estateId).catch(() => null);
    return estate?.settings?.timezone ?? 'Africa/Lagos';
  }

  private async build(
    context: RequestContext,
    type: ReportType,
    range: ReportRange,
    rowLimit: number,
    timezone: string,
  ): Promise<BuiltReport> {
    switch (type) {
      case 'collections':
        return this.collections(context, range, rowLimit, timezone);
      case 'gate-activity':
        return this.gateActivity(context, range, rowLimit, timezone);
      case 'residents':
        return this.residents(context, range, rowLimit, timezone);
      case 'incidents':
        return this.incidents(context, range, rowLimit, timezone);
      case 'visitors':
        return this.visitors(context, range, rowLimit, timezone);
    }
  }

  // -------------------------------------------------------------------------
  // 1. Collections
  // -------------------------------------------------------------------------

  private async collections(
    context: RequestContext,
    { from, to }: ReportRange,
    rowLimit: number,
    timezone: string,
  ): Promise<BuiltReport> {
    // Draft invoices have never been sent and cancelled ones were withdrawn;
    // counting either as "invoiced" overstates receivables. An invoice with no
    // `issuedAt` falls back to when it was created so nothing silently drops
    // out of the range.
    const dated: PipelineStage = {
      $addFields: { effectiveAt: { $ifNull: ['$issuedAt', '$createdAt'] } },
    };
    const inRange: PipelineStage = {
      $match: {
        status: { $nin: ['draft', 'cancelled'] },
        effectiveAt: { $gte: from, $lte: to },
      },
    };

    const [totals, received, byCategory, byMonth, detail, feeCategories] = await Promise.all([
      invoices.aggregate<InvoiceTotals>(context, [
        dated,
        inRange,
        {
          $group: {
            _id: null,
            invoiced: { $sum: '$total' },
            paid: { $sum: '$amountPaid' },
            penalties: { $sum: '$penaltyAmount' },
            count: { $sum: 1 },
            overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } },
          },
        },
      ]),
      payments.aggregate<PaymentTotals>(context, [
        { $match: { status: 'successful', paidAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            collected: { $sum: '$amount' },
            providerFees: { $sum: '$providerFee' },
            count: { $sum: 1 },
            households: { $addToSet: '$membershipId' },
          },
        },
        {
          $project: {
            collected: 1,
            providerFees: 1,
            count: 1,
            households: { $size: '$households' },
          },
        },
      ]),
      invoices.aggregate<CategoryRow>(context, [
        dated,
        inRange,
        { $unwind: '$lines' },
        {
          $group: {
            _id: '$lines.feeCategoryId',
            invoiced: { $sum: '$lines.lineTotal' },
            invoiceIds: { $addToSet: '$_id' },
          },
        },
        { $project: { invoiced: 1, invoices: { $size: '$invoiceIds' } } },
        { $sort: { invoiced: -1 } },
      ]),
      invoices.aggregate<MonthRow>(context, [
        dated,
        inRange,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$effectiveAt', timezone } },
            invoiced: { $sum: '$total' },
            paid: { $sum: '$amountPaid' },
            invoiceCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      invoices.aggregate<Facet<InvoiceDetailRow>>(context, [
        dated,
        inRange,
        facet([{ $sort: { effectiveAt: -1 } }] as PipelineStage.FacetPipelineStage[], rowLimit, [
          {
            $lookup: {
              from: 'properties',
              localField: 'propertyId',
              foreignField: '_id',
              as: 'property',
              pipeline: [{ $project: { unitNumber: 1 } }],
            },
          },
          {
            $lookup: {
              from: 'memberships',
              localField: 'membershipId',
              foreignField: '_id',
              as: 'membership',
              pipeline: [{ $project: { residentCode: 1 } }],
            },
          },
          {
            $project: {
              number: 1,
              status: 1,
              total: 1,
              amountPaid: 1,
              dueAt: 1,
              effectiveAt: 1,
              unitNumber: { $first: '$property.unitNumber' },
              residentCode: { $first: '$membership.residentCode' },
            },
          },
        ] as PipelineStage.FacetPipelineStage[]),
      ]),
      fees.findMany(context, {}, { select: 'code name' }),
    ]);

    const invoiced = toNumber(totals[0]?.invoiced);
    const paidAgainst = toNumber(totals[0]?.paid);
    const collected = toNumber(received[0]?.collected);
    const outstanding = invoiced - paidAgainst;

    const feeNames = new Map(
      feeCategories.map((fee) => [fee._id.toHexString(), `${fee.name} (${fee.code})`]),
    );

    const summary: ReportStat[] = [
      { key: 'invoiced', label: 'Invoiced', value: invoiced, format: 'money' },
      {
        key: 'collected',
        label: 'Collected',
        value: collected,
        format: 'money',
        hint: 'Payments settled in this period, whatever period the invoice belongs to.',
      },
      { key: 'outstanding', label: 'Outstanding', value: outstanding, format: 'money' },
      {
        key: 'collectionRate',
        label: 'Collection rate',
        value: percent(paidAgainst, invoiced),
        format: 'percent',
        hint: 'How much of what was invoiced in this period has been paid.',
      },
      {
        key: 'invoiceCount',
        label: 'Invoices',
        value: toNumber(totals[0]?.count),
        format: 'number',
      },
      {
        key: 'overdue',
        label: 'Overdue invoices',
        value: toNumber(totals[0]?.overdue),
        format: 'number',
      },
      {
        key: 'penalties',
        label: 'Late penalties',
        value: toNumber(totals[0]?.penalties),
        format: 'money',
      },
      {
        key: 'providerFees',
        label: 'Provider fees',
        value: toNumber(received[0]?.providerFees),
        format: 'money',
      },
      {
        key: 'payingHouseholds',
        label: 'Paying households',
        value: toNumber(received[0]?.households),
        format: 'number',
      },
    ];

    const categoryRows: ReportRow[] = byCategory.map((row) => ({
      category: row._id ? (feeNames.get(String(row._id)) ?? 'Unmapped fee') : 'Ad-hoc line',
      invoices: toNumber(row.invoices),
      invoiced: toNumber(row.invoiced),
      share: percent(toNumber(row.invoiced), invoiced),
    }));

    const monthRows: ReportRow[] = byMonth.map((row) => ({
      month: toText(row._id),
      invoiceCount: toNumber(row.invoiceCount),
      invoiced: toNumber(row.invoiced),
      collected: toNumber(row.paid),
      outstanding: toNumber(row.invoiced) - toNumber(row.paid),
    }));

    const details = unpackFacet<InvoiceDetailRow>(detail);
    const detailRows: ReportRow[] = details.rows.map((row) => ({
      number: toText(row.number),
      residentCode: textOrNull(row.residentCode),
      unitNumber: textOrNull(row.unitNumber),
      status: toText(row.status),
      issuedAt: iso(row.effectiveAt),
      dueAt: iso(row.dueAt),
      total: toNumber(row.total),
      paid: toNumber(row.amountPaid),
      outstanding: toNumber(row.total) - toNumber(row.amountPaid),
    }));

    return {
      summary,
      tables: [
        {
          trend: false,
          table: makeTable(
            'by-category',
            'By fee category',
            [
              { key: 'category', label: 'Fee category', format: 'text' },
              { key: 'invoices', label: 'Invoices', format: 'number' },
              { key: 'invoiced', label: 'Invoiced', format: 'money' },
              { key: 'share', label: 'Share of billing', format: 'percent' },
            ],
            categoryRows,
            categoryRows.length,
          ),
        },
        {
          trend: true,
          table: makeTable(
            'by-month',
            'By month',
            [
              { key: 'month', label: 'Month', format: 'text' },
              { key: 'invoiceCount', label: 'Invoices', format: 'number' },
              { key: 'invoiced', label: 'Invoiced', format: 'money' },
              { key: 'collected', label: 'Paid', format: 'money' },
              { key: 'outstanding', label: 'Outstanding', format: 'money' },
            ],
            monthRows,
            monthRows.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'detail',
            'Invoices',
            [
              { key: 'number', label: 'Invoice', format: 'text' },
              { key: 'residentCode', label: 'Resident code', format: 'text' },
              { key: 'unitNumber', label: 'Unit', format: 'text' },
              { key: 'status', label: 'Status', format: 'text' },
              { key: 'issuedAt', label: 'Issued', format: 'date' },
              { key: 'dueAt', label: 'Due', format: 'date' },
              { key: 'total', label: 'Total', format: 'money' },
              { key: 'paid', label: 'Paid', format: 'money' },
              { key: 'outstanding', label: 'Outstanding', format: 'money' },
            ],
            detailRows,
            details.total,
          ),
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 2. Gate activity
  // -------------------------------------------------------------------------

  private async gateActivity(
    context: RequestContext,
    { from, to }: ReportRange,
    rowLimit: number,
    timezone: string,
  ): Promise<BuiltReport> {
    const inRange: PipelineStage = { $match: { occurredAt: { $gte: from, $lte: to } } };

    // Denials are counted as deliberately as admissions: a refused scan is the
    // more interesting record, and a report that only totals successes cannot
    // show a pattern of them.
    const counters = {
      total: { $sum: 1 },
      entries: { $sum: { $cond: [{ $and: ['$admitted', { $eq: ['$direction', 'in'] }] }, 1, 0] } },
      exits: { $sum: { $cond: [{ $and: ['$admitted', { $eq: ['$direction', 'out'] }] }, 1, 0] } },
      denied: { $sum: { $cond: ['$admitted', 0, 1] } },
    };

    const [totals, byGate, byDay, byHour, detail, gateDocs] = await Promise.all([
      movements.aggregate<GateTotals>(context, [inRange, { $group: { _id: null, ...counters } }]),
      movements.aggregate<GateGroupRow>(context, [
        inRange,
        { $group: { _id: '$gateId', ...counters } },
        { $sort: { total: -1 } },
      ]),
      movements.aggregate<GateGroupRow>(context, [
        inRange,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone } },
            ...counters,
          },
        },
        { $sort: { _id: 1 } },
      ]),
      movements.aggregate<GateGroupRow>(context, [
        inRange,
        {
          $group: {
            _id: { $hour: { date: '$occurredAt', timezone } },
            ...counters,
          },
        },
        { $sort: { _id: 1 } },
      ]),
      movements.aggregate<Facet<MovementDetailRow>>(context, [
        inRange,
        facet([{ $sort: { occurredAt: -1 } }] as PipelineStage.FacetPipelineStage[], rowLimit, [
          {
            $lookup: {
              from: 'gates',
              localField: 'gateId',
              foreignField: '_id',
              as: 'gate',
              pipeline: [{ $project: { code: 1 } }],
            },
          },
          {
            $project: {
              occurredAt: 1,
              direction: 1,
              subject: 1,
              subjectLabel: 1,
              unitNumber: 1,
              vehiclePlate: 1,
              admitted: 1,
              denialReason: 1,
              method: 1,
              partySize: 1,
              gateCode: { $first: '$gate.code' },
            },
          },
        ] as PipelineStage.FacetPipelineStage[]),
      ]),
      gates.findMany(context, {}, { select: 'name code' }),
    ]);

    const gateNames = new Map(
      gateDocs.map((gate) => [gate._id.toHexString(), `${gate.name} (${gate.code})`]),
    );

    const total = toNumber(totals[0]?.total);
    const peak = [...byHour].sort((a, b) => toNumber(b.total) - toNumber(a.total))[0];
    const busiest = byGate[0];

    const summary: ReportStat[] = [
      { key: 'total', label: 'Movements', value: total, format: 'number' },
      { key: 'entries', label: 'Entries', value: toNumber(totals[0]?.entries), format: 'number' },
      { key: 'exits', label: 'Exits', value: toNumber(totals[0]?.exits), format: 'number' },
      { key: 'denied', label: 'Denied', value: toNumber(totals[0]?.denied), format: 'number' },
      {
        key: 'denialRate',
        label: 'Denial rate',
        value: percent(toNumber(totals[0]?.denied), total),
        format: 'percent',
      },
      {
        key: 'busiestGate',
        label: 'Busiest gate',
        value: busiest ? (gateNames.get(String(busiest._id)) ?? 'Unknown gate') : null,
        format: 'text',
      },
      {
        key: 'peakHour',
        label: 'Peak hour',
        value: peak ? `${String(peak._id).padStart(2, '0')}:00` : null,
        format: 'text',
        hint: `Local time (${timezone}).`,
      },
    ];

    const gateRows: ReportRow[] = byGate.map((row) => ({
      gate: gateNames.get(String(row._id)) ?? 'Unknown gate',
      total: toNumber(row.total),
      entries: toNumber(row.entries),
      exits: toNumber(row.exits),
      denied: toNumber(row.denied),
      denialRate: percent(toNumber(row.denied), toNumber(row.total)),
    }));

    const dayRows: ReportRow[] = byDay.map((row) => ({
      day: toText(row._id),
      total: toNumber(row.total),
      entries: toNumber(row.entries),
      exits: toNumber(row.exits),
      denied: toNumber(row.denied),
    }));

    const hourRows: ReportRow[] = byHour.map((row) => ({
      hour: `${String(row._id).padStart(2, '0')}:00`,
      total: toNumber(row.total),
      entries: toNumber(row.entries),
      exits: toNumber(row.exits),
      denied: toNumber(row.denied),
    }));

    const details = unpackFacet<MovementDetailRow>(detail);
    const detailRows: ReportRow[] = details.rows.map((row) => ({
      occurredAt: iso(row.occurredAt),
      gate: textOrNull(row.gateCode),
      direction: toText(row.direction),
      subject: toText(row.subject),
      subjectLabel: toText(row.subjectLabel),
      unitNumber: textOrNull(row.unitNumber),
      vehiclePlate: textOrNull(row.vehiclePlate),
      partySize: row.partySize ?? null,
      admitted: row.admitted === true,
      denialReason: textOrNull(row.denialReason),
      method: toText(row.method),
    }));

    const groupColumns: ReportColumn[] = [
      { key: 'total', label: 'Movements', format: 'number' },
      { key: 'entries', label: 'Entries', format: 'number' },
      { key: 'exits', label: 'Exits', format: 'number' },
      { key: 'denied', label: 'Denied', format: 'number' },
    ];

    return {
      summary,
      tables: [
        {
          trend: false,
          table: makeTable(
            'by-gate',
            'By gate',
            [
              { key: 'gate', label: 'Gate', format: 'text' },
              ...groupColumns,
              { key: 'denialRate', label: 'Denial rate', format: 'percent' },
            ],
            gateRows,
            gateRows.length,
          ),
        },
        {
          trend: true,
          table: makeTable(
            'by-day',
            'By day',
            [{ key: 'day', label: 'Day', format: 'text' }, ...groupColumns],
            dayRows,
            dayRows.length,
          ),
        },
        {
          trend: true,
          table: makeTable(
            'by-hour',
            'By hour of day',
            [{ key: 'hour', label: 'Hour', format: 'text' }, ...groupColumns],
            hourRows,
            hourRows.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'detail',
            'Movement log',
            [
              { key: 'occurredAt', label: 'When', format: 'datetime' },
              { key: 'gate', label: 'Gate', format: 'text' },
              { key: 'direction', label: 'Direction', format: 'text' },
              { key: 'subject', label: 'Subject', format: 'text' },
              { key: 'subjectLabel', label: 'Who', format: 'text' },
              { key: 'unitNumber', label: 'Unit', format: 'text' },
              { key: 'vehiclePlate', label: 'Plate', format: 'text' },
              { key: 'partySize', label: 'Party size', format: 'number' },
              { key: 'admitted', label: 'Admitted', format: 'text' },
              { key: 'denialReason', label: 'Denial reason', format: 'text' },
              { key: 'method', label: 'Method', format: 'text' },
            ],
            detailRows,
            details.total,
          ),
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 3. Residents
  // -------------------------------------------------------------------------

  private async residents(
    context: RequestContext,
    { from, to }: ReportRange,
    rowLimit: number,
    timezone: string,
  ): Promise<BuiltReport> {
    // Headcount is a statement about now, not about the range: "how many
    // tenants do we have" does not become a different number because someone
    // asked for last quarter. The range governs the movement figures only, and
    // the report says so.
    const statusCounters = {
      total: { $sum: 1 },
      active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      pending: {
        $sum: { $cond: [{ $in: ['$status', ['pending', 'awaiting-approval']] }, 1, 0] },
      },
      suspended: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
      exited: { $sum: { $cond: [{ $eq: ['$status', 'exited'] }, 1, 0] } },
    };

    const [totals, byCategory, moveIns, moveOuts, detail] = await Promise.all([
      memberships.aggregate<ResidentTotals>(context, [
        { $group: { _id: null, ...statusCounters } },
      ]),
      memberships.aggregate<ResidentGroupRow>(context, [
        { $group: { _id: '$category', ...statusCounters } },
        { $sort: { total: -1 } },
      ]),
      memberships.aggregate<MoveRow>(context, [
        { $match: { movedInAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$movedInAt', timezone } },
            count: { $sum: 1 },
          },
        },
      ]),
      memberships.aggregate<MoveRow>(context, [
        { $match: { movedOutAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$movedOutAt', timezone } },
            count: { $sum: 1 },
          },
        },
      ]),
      memberships.aggregate<Facet<ResidentDetailRow>>(context, [
        facet([{ $sort: { createdAt: -1 } }] as PipelineStage.FacetPipelineStage[], rowLimit, [
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: '_id',
              as: 'user',
              // Name only. Email, phone and anything derived from the NIN are
              // deliberately absent: a spreadsheet is forwarded, archived and
              // eventually mislaid, and contact details do not need to travel
              // with a headcount.
              pipeline: [{ $project: { firstName: 1, lastName: 1 } }],
            },
          },
          {
            $lookup: {
              from: 'properties',
              localField: 'propertyId',
              foreignField: '_id',
              as: 'property',
              pipeline: [{ $project: { unitNumber: 1 } }],
            },
          },
          {
            $project: {
              residentCode: 1,
              category: 1,
              status: 1,
              movedInAt: 1,
              movedOutAt: 1,
              approvedAt: 1,
              createdAt: 1,
              firstName: { $first: '$user.firstName' },
              lastName: { $first: '$user.lastName' },
              unitNumber: { $first: '$property.unitNumber' },
            },
          },
        ] as PipelineStage.FacetPipelineStage[]),
      ]),
    ]);

    const moveInTotal = moveIns.reduce((sum, row) => sum + toNumber(row.count), 0);
    const moveOutTotal = moveOuts.reduce((sum, row) => sum + toNumber(row.count), 0);

    const summary: ReportStat[] = [
      {
        key: 'active',
        label: 'Active residents',
        value: toNumber(totals[0]?.active),
        format: 'number',
      },
      {
        key: 'pending',
        label: 'Awaiting approval',
        value: toNumber(totals[0]?.pending),
        format: 'number',
      },
      {
        key: 'suspended',
        label: 'Suspended',
        value: toNumber(totals[0]?.suspended),
        format: 'number',
      },
      { key: 'exited', label: 'Exited', value: toNumber(totals[0]?.exited), format: 'number' },
      {
        key: 'moveIns',
        label: 'Move-ins',
        value: moveInTotal,
        format: 'number',
        hint: 'Within the selected range. Headcounts above are current.',
      },
      { key: 'moveOuts', label: 'Move-outs', value: moveOutTotal, format: 'number' },
      {
        key: 'netChange',
        label: 'Net change',
        value: moveInTotal - moveOutTotal,
        format: 'number',
      },
    ];

    const categoryRows: ReportRow[] = byCategory.map((row) => ({
      category: toText(row._id, 'unspecified'),
      total: toNumber(row.total),
      active: toNumber(row.active),
      pending: toNumber(row.pending),
      suspended: toNumber(row.suspended),
      exited: toNumber(row.exited),
    }));

    const months = [...new Set([...moveIns, ...moveOuts].map((row) => toText(row._id)))].sort();
    const movementRows: ReportRow[] = months.map((month) => ({
      month,
      moveIns: toNumber(moveIns.find((row) => row._id === month)?.count),
      moveOuts: toNumber(moveOuts.find((row) => row._id === month)?.count),
      net:
        toNumber(moveIns.find((row) => row._id === month)?.count) -
        toNumber(moveOuts.find((row) => row._id === month)?.count),
    }));

    const details = unpackFacet<ResidentDetailRow>(detail);
    const detailRows: ReportRow[] = details.rows.map((row) => ({
      residentCode: textOrNull(row.residentCode),
      name: `${toText(row.firstName)} ${toText(row.lastName)}`.trim() || null,
      category: toText(row.category),
      status: toText(row.status),
      unitNumber: textOrNull(row.unitNumber),
      registeredAt: iso(row.createdAt),
      approvedAt: iso(row.approvedAt),
      movedInAt: iso(row.movedInAt),
      movedOutAt: iso(row.movedOutAt),
    }));

    return {
      summary,
      tables: [
        {
          trend: false,
          table: makeTable(
            'by-category',
            'By category',
            [
              { key: 'category', label: 'Category', format: 'text' },
              { key: 'total', label: 'Total', format: 'number' },
              { key: 'active', label: 'Active', format: 'number' },
              { key: 'pending', label: 'Awaiting approval', format: 'number' },
              { key: 'suspended', label: 'Suspended', format: 'number' },
              { key: 'exited', label: 'Exited', format: 'number' },
            ],
            categoryRows,
            categoryRows.length,
          ),
        },
        {
          trend: true,
          table: makeTable(
            'movement',
            'Move-ins and move-outs',
            [
              { key: 'month', label: 'Month', format: 'text' },
              { key: 'moveIns', label: 'Move-ins', format: 'number' },
              { key: 'moveOuts', label: 'Move-outs', format: 'number' },
              { key: 'net', label: 'Net', format: 'number' },
            ],
            movementRows,
            movementRows.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'detail',
            'Resident roster',
            [
              { key: 'residentCode', label: 'Resident code', format: 'text' },
              { key: 'name', label: 'Name', format: 'text' },
              { key: 'category', label: 'Category', format: 'text' },
              { key: 'status', label: 'Status', format: 'text' },
              { key: 'unitNumber', label: 'Unit', format: 'text' },
              { key: 'registeredAt', label: 'Registered', format: 'date' },
              { key: 'approvedAt', label: 'Approved', format: 'date' },
              { key: 'movedInAt', label: 'Moved in', format: 'date' },
              { key: 'movedOutAt', label: 'Moved out', format: 'date' },
            ],
            detailRows,
            details.total,
          ),
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 4. Incidents & safety
  // -------------------------------------------------------------------------

  private async incidents(
    context: RequestContext,
    { from, to }: ReportRange,
    rowLimit: number,
    timezone: string,
  ): Promise<BuiltReport> {
    const now = new Date();

    // Severity decides the target, so a noise complaint answered in a week is
    // not counted against the same clock as a fire. The numbers live in
    // `INCIDENT_SLA_HOURS` and are a reporting convention, not something the
    // incident workflow enforces — stated here so the figure is accountable.
    const targetHours: Record<string, unknown> = {
      $switch: {
        branches: Object.entries(INCIDENT_SLA_HOURS).map(([severity, hours]) => ({
          case: { $eq: ['$severity', severity] },
          then: hours,
        })),
        default: INCIDENT_SLA_HOURS.low ?? 168,
      },
    };

    const derive: PipelineStage[] = [
      { $match: { occurredAt: { $gte: from, $lte: to } } },
      {
        $addFields: {
          targetHours,
          resolutionHours: {
            $cond: [
              { $ifNull: ['$resolvedAt', false] },
              { $divide: [{ $subtract: ['$resolvedAt', '$occurredAt'] }, HOUR_MS] },
              null,
            ],
          },
          elapsedHours: { $divide: [{ $subtract: [now, '$occurredAt'] }, HOUR_MS] },
        },
      },
      {
        // An incident still open past its target has already breached; waiting
        // for it to be resolved before counting it would make the worst cases
        // the last to appear.
        $addFields: {
          breached: {
            $cond: [
              { $ne: ['$resolutionHours', null] },
              { $gt: ['$resolutionHours', '$targetHours'] },
              { $gt: ['$elapsedHours', '$targetHours'] },
            ],
          },
        },
      },
    ];

    const counters = {
      total: { $sum: 1 },
      resolved: { $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 1, 0] } },
      open: { $sum: { $cond: [{ $in: ['$status', ['resolved', 'closed']] }, 0, 1] } },
      meanHours: { $avg: '$resolutionHours' },
      breaches: { $sum: { $cond: ['$breached', 1, 0] } },
    };

    const [totals, byCategory, bySeverity, byMonth, detail] = await Promise.all([
      incidents.aggregate<IncidentTotals>(context, [
        ...derive,
        {
          $group: {
            _id: null,
            ...counters,
            critical: {
              $sum: { $cond: [{ $in: ['$severity', ['critical', 'high']] }, 1, 0] },
            },
          },
        },
      ]),
      incidents.aggregate<IncidentGroupRow>(context, [
        ...derive,
        { $group: { _id: '$category', ...counters } },
        { $sort: { total: -1 } },
      ]),
      incidents.aggregate<IncidentGroupRow>(context, [
        ...derive,
        { $group: { _id: '$severity', ...counters, rank: { $max: '$severityRank' } } },
        { $sort: { rank: -1 } },
      ]),
      incidents.aggregate<IncidentGroupRow>(context, [
        ...derive,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$occurredAt', timezone } },
            ...counters,
          },
        },
        { $sort: { _id: 1 } },
      ]),
      incidents.aggregate<Facet<IncidentDetailRow>>(context, [
        ...derive,
        facet([{ $sort: { occurredAt: -1 } }] as PipelineStage.FacetPipelineStage[], rowLimit, [
          {
            // Title, not description. The narrative of an incident is what
            // `incident.viewAll` opens on screen; it has no business being
            // duplicated into a file that leaves the audited system.
            $project: {
              reference: 1,
              title: 1,
              category: 1,
              severity: 1,
              status: 1,
              occurredAt: 1,
              resolvedAt: 1,
              resolutionHours: 1,
              targetHours: 1,
              breached: 1,
            },
          },
        ] as PipelineStage.FacetPipelineStage[]),
      ]),
    ]);

    const total = toNumber(totals[0]?.total);

    const summary: ReportStat[] = [
      { key: 'total', label: 'Incidents', value: total, format: 'number' },
      { key: 'open', label: 'Still open', value: toNumber(totals[0]?.open), format: 'number' },
      {
        key: 'resolved',
        label: 'Resolved',
        value: toNumber(totals[0]?.resolved),
        format: 'number',
      },
      {
        key: 'critical',
        label: 'High or critical',
        value: toNumber(totals[0]?.critical),
        format: 'number',
      },
      {
        key: 'meanHours',
        label: 'Mean time to resolve',
        value: meanOrNull(totals[0]?.meanHours),
        format: 'hours',
        hint: 'Resolved incidents only. Those still open are counted in the breach figure instead.',
      },
      {
        key: 'breaches',
        label: 'SLA breaches',
        value: toNumber(totals[0]?.breaches),
        format: 'number',
      },
      {
        key: 'breachRate',
        label: 'Breach rate',
        value: percent(toNumber(totals[0]?.breaches), total),
        format: 'percent',
      },
    ];

    const groupRow = (row: IncidentGroupRow): ReportRow => ({
      key: toText(row._id, 'unspecified'),
      total: toNumber(row.total),
      open: toNumber(row.open),
      resolved: toNumber(row.resolved),
      meanHours: meanOrNull(row.meanHours),
      breaches: toNumber(row.breaches),
      breachRate: percent(toNumber(row.breaches), toNumber(row.total)),
    });

    const groupColumns = (label: string): ReportColumn[] => [
      { key: 'key', label, format: 'text' },
      { key: 'total', label: 'Incidents', format: 'number' },
      { key: 'open', label: 'Open', format: 'number' },
      { key: 'resolved', label: 'Resolved', format: 'number' },
      { key: 'meanHours', label: 'Mean time to resolve', format: 'hours' },
      { key: 'breaches', label: 'SLA breaches', format: 'number' },
      { key: 'breachRate', label: 'Breach rate', format: 'percent' },
    ];

    const details = unpackFacet<IncidentDetailRow>(detail);
    const detailRows: ReportRow[] = details.rows.map((row) => ({
      reference: toText(row.reference),
      title: toText(row.title),
      category: toText(row.category),
      severity: toText(row.severity),
      status: toText(row.status),
      occurredAt: iso(row.occurredAt),
      resolvedAt: iso(row.resolvedAt),
      resolutionHours: row.resolutionHours === null ? null : round1(toNumber(row.resolutionHours)),
      targetHours: toNumber(row.targetHours),
      breached: row.breached === true,
    }));

    return {
      summary,
      tables: [
        {
          trend: false,
          table: makeTable(
            'by-category',
            'By category',
            groupColumns('Category'),
            byCategory.map(groupRow),
            byCategory.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'by-severity',
            'By severity',
            groupColumns('Severity'),
            bySeverity.map(groupRow),
            bySeverity.length,
          ),
        },
        {
          trend: true,
          table: makeTable(
            'by-month',
            'By month',
            groupColumns('Month'),
            byMonth.map(groupRow),
            byMonth.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'detail',
            'Incidents',
            [
              { key: 'reference', label: 'Reference', format: 'text' },
              { key: 'title', label: 'Title', format: 'text' },
              { key: 'category', label: 'Category', format: 'text' },
              { key: 'severity', label: 'Severity', format: 'text' },
              { key: 'status', label: 'Status', format: 'text' },
              { key: 'occurredAt', label: 'Occurred', format: 'datetime' },
              { key: 'resolvedAt', label: 'Resolved', format: 'datetime' },
              { key: 'resolutionHours', label: 'Time to resolve', format: 'hours' },
              { key: 'targetHours', label: 'Target', format: 'hours' },
              { key: 'breached', label: 'Breached', format: 'text' },
            ],
            detailRows,
            details.total,
          ),
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 5. Visitors
  // -------------------------------------------------------------------------

  private async visitors(
    context: RequestContext,
    { from, to }: ReportRange,
    rowLimit: number,
    timezone: string,
  ): Promise<BuiltReport> {
    const now = new Date();

    const derive: PipelineStage[] = [
      { $match: { expectedArrival: { $gte: from, $lte: to } } },
      {
        $addFields: {
          arrived: { $cond: [{ $ifNull: ['$checkedInAt', false] }, true, false] },
          stayHours: {
            $cond: [
              {
                $and: [{ $ifNull: ['$checkedInAt', false] }, { $ifNull: ['$checkedOutAt', false] }],
              },
              { $divide: [{ $subtract: ['$checkedOutAt', '$checkedInAt'] }, HOUR_MS] },
              null,
            ],
          },
          // Someone still inside past their window is overstaying now, not
          // once they eventually leave — which is the case security cares
          // about and the one a completed-visits-only measure would miss.
          overstayed: {
            $or: [
              {
                $and: [
                  { $ifNull: ['$checkedOutAt', false] },
                  { $gt: ['$checkedOutAt', '$expectedDeparture'] },
                ],
              },
              {
                $and: [{ $eq: ['$status', 'inside'] }, { $gt: [now, '$expectedDeparture'] }],
              },
            ],
          },
        },
      },
    ];

    const counters = {
      total: { $sum: 1 },
      arrived: { $sum: { $cond: ['$arrived', 1, 0] } },
      overstays: { $sum: { $cond: ['$overstayed', 1, 0] } },
      denied: { $sum: { $cond: [{ $eq: ['$status', 'denied'] }, 1, 0] } },
      noShow: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
      inside: { $sum: { $cond: [{ $eq: ['$status', 'inside'] }, 1, 0] } },
      guests: { $sum: '$partySize' },
      meanStayHours: { $avg: '$stayHours' },
    };

    const [totals, byMonth, topHosts, detail] = await Promise.all([
      visitors.aggregate<VisitorTotals>(context, [
        ...derive,
        {
          $group: {
            _id: null,
            ...counters,
            walkIns: { $sum: { $cond: [{ $eq: ['$passType', 'walk-in'] }, 1, 0] } },
          },
        },
      ]),
      visitors.aggregate<VisitorGroupRow>(context, [
        ...derive,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$expectedArrival', timezone } },
            ...counters,
          },
        },
        { $sort: { _id: 1 } },
      ]),
      visitors.aggregate<HostRow>(context, [
        ...derive,
        {
          $group: {
            _id: '$hostMembershipId',
            ...counters,
            propertyId: { $first: '$propertyId' },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 25 },
        {
          $lookup: {
            from: 'memberships',
            localField: '_id',
            foreignField: '_id',
            as: 'membership',
            pipeline: [{ $project: { residentCode: 1 } }],
          },
        },
        {
          $lookup: {
            from: 'properties',
            localField: 'propertyId',
            foreignField: '_id',
            as: 'property',
            pipeline: [{ $project: { unitNumber: 1 } }],
          },
        },
        {
          $project: {
            total: 1,
            arrived: 1,
            overstays: 1,
            guests: 1,
            residentCode: { $first: '$membership.residentCode' },
            unitNumber: { $first: '$property.unitNumber' },
          },
        },
      ]),
      visitors.aggregate<Facet<VisitorDetailRow>>(context, [
        ...derive,
        facet(
          [{ $sort: { expectedArrival: -1 } }] as PipelineStage.FacetPipelineStage[],
          rowLimit,
          [
            {
              $lookup: {
                from: 'properties',
                localField: 'propertyId',
                foreignField: '_id',
                as: 'property',
                pipeline: [{ $project: { unitNumber: 1 } }],
              },
            },
            {
              // `code` is absent on purpose: it is the credential a gate
              // accepts, and a list of live codes is not a report.
              $project: {
                visitorName: 1,
                passType: 1,
                purpose: 1,
                partySize: 1,
                expectedArrival: 1,
                expectedDeparture: 1,
                checkedInAt: 1,
                checkedOutAt: 1,
                status: 1,
                overstayed: 1,
                stayHours: 1,
                unitNumber: { $first: '$property.unitNumber' },
              },
            },
          ] as PipelineStage.FacetPipelineStage[],
        ),
      ]),
    ]);

    const total = toNumber(totals[0]?.total);
    const arrived = toNumber(totals[0]?.arrived);

    const summary: ReportStat[] = [
      { key: 'total', label: 'Visits booked', value: total, format: 'number' },
      { key: 'arrived', label: 'Arrived', value: arrived, format: 'number' },
      {
        key: 'guests',
        label: 'People admitted',
        value: toNumber(totals[0]?.guests),
        format: 'number',
      },
      { key: 'walkIns', label: 'Walk-ins', value: toNumber(totals[0]?.walkIns), format: 'number' },
      { key: 'noShow', label: 'No-shows', value: toNumber(totals[0]?.noShow), format: 'number' },
      {
        key: 'denied',
        label: 'Denied at the gate',
        value: toNumber(totals[0]?.denied),
        format: 'number',
      },
      {
        key: 'inside',
        label: 'Still inside',
        value: toNumber(totals[0]?.inside),
        format: 'number',
      },
      {
        key: 'overstayRate',
        label: 'Overstay rate',
        value: percent(toNumber(totals[0]?.overstays), arrived),
        format: 'percent',
        hint: 'Share of visitors who arrived and stayed past their expected departure.',
      },
      {
        key: 'meanStayHours',
        label: 'Mean stay',
        value: meanOrNull(totals[0]?.meanStayHours),
        format: 'hours',
      },
    ];

    const dayRows: ReportRow[] = byMonth.map((row) => ({
      day: toText(row._id),
      total: toNumber(row.total),
      arrived: toNumber(row.arrived),
      guests: toNumber(row.guests),
      overstays: toNumber(row.overstays),
      noShow: toNumber(row.noShow),
    }));

    const hostRows: ReportRow[] = topHosts.map((row) => ({
      residentCode: textOrNull(row.residentCode),
      unitNumber: textOrNull(row.unitNumber),
      total: toNumber(row.total),
      arrived: toNumber(row.arrived),
      guests: toNumber(row.guests),
      overstays: toNumber(row.overstays),
    }));

    const details = unpackFacet<VisitorDetailRow>(detail);
    const detailRows: ReportRow[] = details.rows.map((row) => ({
      visitorName: toText(row.visitorName),
      unitNumber: textOrNull(row.unitNumber),
      passType: toText(row.passType),
      purpose: toText(row.purpose),
      partySize: toNumber(row.partySize),
      expectedArrival: iso(row.expectedArrival),
      expectedDeparture: iso(row.expectedDeparture),
      checkedInAt: iso(row.checkedInAt),
      checkedOutAt: iso(row.checkedOutAt),
      stayHours: row.stayHours === null ? null : round1(toNumber(row.stayHours)),
      status: toText(row.status),
      overstayed: row.overstayed === true,
    }));

    return {
      summary,
      tables: [
        {
          trend: true,
          table: makeTable(
            'by-day',
            'By day',
            [
              { key: 'day', label: 'Day', format: 'text' },
              { key: 'total', label: 'Booked', format: 'number' },
              { key: 'arrived', label: 'Arrived', format: 'number' },
              { key: 'guests', label: 'People', format: 'number' },
              { key: 'overstays', label: 'Overstays', format: 'number' },
              { key: 'noShow', label: 'No-shows', format: 'number' },
            ],
            dayRows,
            dayRows.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'top-hosts',
            'Top hosts',
            [
              { key: 'residentCode', label: 'Resident code', format: 'text' },
              { key: 'unitNumber', label: 'Unit', format: 'text' },
              { key: 'total', label: 'Visits booked', format: 'number' },
              { key: 'arrived', label: 'Arrived', format: 'number' },
              { key: 'guests', label: 'People', format: 'number' },
              { key: 'overstays', label: 'Overstays', format: 'number' },
            ],
            hostRows,
            hostRows.length,
          ),
        },
        {
          trend: false,
          table: makeTable(
            'detail',
            'Visits',
            [
              { key: 'visitorName', label: 'Visitor', format: 'text' },
              { key: 'unitNumber', label: 'Unit', format: 'text' },
              { key: 'passType', label: 'Pass type', format: 'text' },
              { key: 'purpose', label: 'Purpose', format: 'text' },
              { key: 'partySize', label: 'Party size', format: 'number' },
              { key: 'expectedArrival', label: 'Expected arrival', format: 'datetime' },
              { key: 'expectedDeparture', label: 'Expected departure', format: 'datetime' },
              { key: 'checkedInAt', label: 'Checked in', format: 'datetime' },
              { key: 'checkedOutAt', label: 'Checked out', format: 'datetime' },
              { key: 'stayHours', label: 'Stay', format: 'hours' },
              { key: 'status', label: 'Status', format: 'text' },
              { key: 'overstayed', label: 'Overstayed', format: 'text' },
            ],
            detailRows,
            details.total,
          ),
        },
      ],
    };
  }
}

export const reportService = new ReportService();

// ---------------------------------------------------------------------------
// Aggregation result shapes
//
// Declared rather than inferred: an aggregation returns whatever the pipeline
// says it does, and `any` here would quietly hide a renamed field until a
// column rendered blank in someone's spreadsheet.
// ---------------------------------------------------------------------------

interface BuiltTable {
  table: ReportTable;
  /** A time series. Shown only to callers holding `analytics.view`. */
  trend: boolean;
}

interface BuiltReport {
  summary: ReportStat[];
  tables: BuiltTable[];
}

interface InvoiceTotals {
  invoiced: number;
  paid: number;
  penalties: number;
  count: number;
  overdue: number;
}

interface PaymentTotals {
  collected: number;
  providerFees: number;
  count: number;
  households: number;
}

interface CategoryRow {
  _id: unknown;
  invoiced: number;
  invoices: number;
}

interface MonthRow {
  _id: string;
  invoiced: number;
  paid: number;
  invoiceCount: number;
}

interface InvoiceDetailRow {
  number?: string;
  status?: string;
  total?: number;
  amountPaid?: number;
  dueAt?: Date;
  effectiveAt?: Date;
  unitNumber?: string;
  residentCode?: string;
}

interface GateTotals {
  total: number;
  entries: number;
  exits: number;
  denied: number;
}

interface GateGroupRow extends GateTotals {
  _id: unknown;
}

interface MovementDetailRow {
  occurredAt?: Date;
  direction?: string;
  subject?: string;
  subjectLabel?: string;
  unitNumber?: string | null;
  vehiclePlate?: string | null;
  admitted?: boolean;
  denialReason?: string | null;
  method?: string;
  partySize?: number | null;
  gateCode?: string;
}

interface ResidentTotals {
  total: number;
  active: number;
  pending: number;
  suspended: number;
  exited: number;
}

interface ResidentGroupRow extends ResidentTotals {
  _id: unknown;
}

interface MoveRow {
  _id: string;
  count: number;
}

interface ResidentDetailRow {
  residentCode?: string | null;
  category?: string;
  status?: string;
  movedInAt?: Date | null;
  movedOutAt?: Date | null;
  approvedAt?: Date | null;
  createdAt?: Date;
  firstName?: string;
  lastName?: string;
  unitNumber?: string;
}

interface IncidentTotals {
  total: number;
  resolved: number;
  open: number;
  meanHours: number | null;
  breaches: number;
  critical: number;
}

interface IncidentGroupRow {
  _id: unknown;
  total: number;
  resolved: number;
  open: number;
  meanHours: number | null;
  breaches: number;
}

interface IncidentDetailRow {
  reference?: string;
  title?: string;
  category?: string;
  severity?: string;
  status?: string;
  occurredAt?: Date;
  resolvedAt?: Date | null;
  resolutionHours: number | null;
  targetHours?: number;
  breached?: boolean;
}

interface VisitorCounters {
  total: number;
  arrived: number;
  overstays: number;
  denied: number;
  noShow: number;
  inside: number;
  guests: number;
  meanStayHours: number | null;
}

interface VisitorTotals extends VisitorCounters {
  walkIns: number;
}

interface VisitorGroupRow extends VisitorCounters {
  _id: string;
}

interface HostRow {
  _id: unknown;
  total: number;
  arrived: number;
  overstays: number;
  guests: number;
  residentCode?: string;
  unitNumber?: string;
}

interface VisitorDetailRow {
  visitorName?: string;
  passType?: string;
  purpose?: string;
  partySize?: number;
  expectedArrival?: Date;
  expectedDeparture?: Date;
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  status?: string;
  overstayed?: boolean;
  stayHours: number | null;
  unitNumber?: string;
}
