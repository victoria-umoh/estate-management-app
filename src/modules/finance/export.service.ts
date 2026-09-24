import type { PipelineStage } from 'mongoose';
import { UnprocessableError, ValidationError } from '@/core/errors';
import { PERMISSIONS, assertCan, can, type Permission } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { tableToCsv } from '@/modules/report/csv';
import { EXPORT_ROW_LIMIT, type ReportColumn, type ReportRow } from '@/modules/report/types';
import { invoiceRepository, paymentRepository } from './payment.service';

/**
 * Taking the billing ledger out of the system.
 *
 * `invoice.export` and `payment.export` are separate permissions from
 * `invoice.viewAll` and `payment.view`, and until now they gated nothing at
 * all. That split is the whole point: reading a figure on a screen inside an
 * audited system and carrying the estate's entire receivables ledger out as a
 * file that will be forwarded, archived and eventually mislaid are not the same
 * act, and an estate manager holds one and not the other.
 *
 * Three rules, all of them borrowed from `modules/report` rather than
 * reinvented:
 *
 *  - The CSV is written by `report/csv`. There is exactly one CSV writer in
 *    this codebase, and it is the one that emits a BOM, uses CRLF, quotes
 *    correctly and neutralises formulas. A second writer is a second place for
 *    a resident's `=HYPERLINK(...)` note to become a live formula.
 *  - The permission is checked HERE, in the service, and a refusal is audited
 *    before it throws. A route-level check would reject the request before
 *    anything was written, and a pattern of refused exports is exactly the
 *    signal worth keeping.
 *  - No identity fields. Rows carry the resident CODE and the unit number, as
 *    the collections report already does; no names, addresses, phone numbers,
 *    email addresses or identity numbers reach a spreadsheet.
 */

export interface ExportRange {
  from: Date;
  to: Date;
}

export interface ExportedFile {
  filename: string;
  contentType: string;
  body: string;
  rowCount: number;
  totalRows: number;
  truncated: boolean;
}

/**
 * A year and a day.
 *
 * Long enough for "last financial year", short enough that a single request
 * cannot be made to walk the estate's entire history.
 */
const MAX_RANGE_DAYS = 366;

const INVOICE_COLUMNS: ReportColumn[] = [
  { key: 'number', label: 'Invoice', format: 'text' },
  { key: 'residentCode', label: 'Resident code', format: 'text' },
  { key: 'unitNumber', label: 'Unit', format: 'text' },
  { key: 'status', label: 'Status', format: 'text' },
  { key: 'currency', label: 'Currency', format: 'text' },
  { key: 'subtotal', label: 'Subtotal', format: 'money' },
  { key: 'penalty', label: 'Late penalty', format: 'money' },
  { key: 'total', label: 'Total', format: 'money' },
  { key: 'paid', label: 'Paid', format: 'money' },
  { key: 'outstanding', label: 'Outstanding', format: 'money' },
  { key: 'issuedAt', label: 'Issued', format: 'date' },
  { key: 'dueAt', label: 'Due', format: 'date' },
  { key: 'paidAt', label: 'Settled', format: 'date' },
];

const PAYMENT_COLUMNS: ReportColumn[] = [
  { key: 'reference', label: 'Reference', format: 'text' },
  { key: 'invoiceNumber', label: 'Invoice', format: 'text' },
  { key: 'residentCode', label: 'Resident code', format: 'text' },
  { key: 'unitNumber', label: 'Unit', format: 'text' },
  { key: 'status', label: 'Status', format: 'text' },
  { key: 'provider', label: 'Provider', format: 'text' },
  { key: 'method', label: 'Method', format: 'text' },
  { key: 'currency', label: 'Currency', format: 'text' },
  { key: 'amount', label: 'Amount', format: 'money' },
  { key: 'providerFee', label: 'Provider fee', format: 'money' },
  { key: 'net', label: 'Net', format: 'money' },
  { key: 'verifiedBy', label: 'Verified by', format: 'text' },
  { key: 'paidAt', label: 'Paid', format: 'datetime' },
  { key: 'recordedAt', label: 'Recorded', format: 'datetime' },
];

interface CountedFacet<T> {
  rows?: T[];
  total?: Array<{ n: number }>;
}

/**
 * One pass that returns a capped page and the full count.
 *
 * `$limit` runs BEFORE the joins, so a year of billing does not perform a
 * lookup per row and discard almost all of it. The same shape `modules/report`
 * uses, for the same reason.
 */
function countedFacet(
  sort: PipelineStage.FacetPipelineStage,
  limit: number,
  shape: PipelineStage.FacetPipelineStage[],
): PipelineStage {
  return {
    $facet: {
      rows: [sort, { $limit: limit }, ...shape],
      total: [{ $count: 'n' }],
    },
  } as PipelineStage;
}

/** Join a membership's resident code and a property's unit number, and nothing else. */
const IDENTIFIERS: PipelineStage.FacetPipelineStage[] = [
  {
    $lookup: {
      from: 'memberships',
      localField: 'membershipId',
      foreignField: '_id',
      as: 'membership',
      // Projected inside the lookup so the resident's name and contact details
      // never enter this pipeline in the first place. A later `$project` that
      // forgot one would leak it; this cannot.
      pipeline: [{ $project: { residentCode: 1, propertyId: 1 } }],
    },
  },
  {
    $lookup: {
      from: 'properties',
      localField: 'membership.propertyId',
      foreignField: '_id',
      as: 'property',
      pipeline: [{ $project: { unitNumber: 1 } }],
    },
  },
];

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : '';
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class FinanceExportService {
  /** Invoices raised in the range, whatever their status. */
  async invoices(context: RequestContext, range: ExportRange): Promise<ExportedFile> {
    await this.guard(
      context,
      'invoice',
      PERMISSIONS.INVOICE_VIEW_ALL,
      PERMISSIONS.INVOICE_EXPORT,
      range,
    );

    const { from, to } = assertRange(range);

    const [facet] = await invoiceRepository.aggregate<CountedFacet<Record<string, unknown>>>(
      context,
      [
        // An invoice with no `issuedAt` has never been sent; falling back to
        // creation keeps drafts in the range rather than silently dropping them
        // out of a reconciliation.
        { $addFields: { effectiveAt: { $ifNull: ['$issuedAt', '$createdAt'] } } },
        { $match: { effectiveAt: { $gte: from, $lte: to } } },
        countedFacet({ $sort: { effectiveAt: -1 } }, EXPORT_ROW_LIMIT, [
          ...IDENTIFIERS,
          {
            $project: {
              number: 1,
              status: 1,
              currency: 1,
              subtotal: 1,
              penaltyAmount: 1,
              total: 1,
              amountPaid: 1,
              effectiveAt: 1,
              dueAt: 1,
              paidAt: 1,
              residentCode: { $first: '$membership.residentCode' },
              unitNumber: { $first: '$property.unitNumber' },
            },
          },
        ]),
      ],
    );

    const rows: ReportRow[] = (facet?.rows ?? []).map((row) => ({
      number: text(row.number),
      residentCode: text(row.residentCode),
      unitNumber: text(row.unitNumber),
      status: text(row.status),
      currency: text(row.currency),
      subtotal: num(row.subtotal),
      penalty: num(row.penaltyAmount),
      total: num(row.total),
      paid: num(row.amountPaid),
      outstanding: num(row.total) - num(row.amountPaid),
      issuedAt: iso(row.effectiveAt),
      dueAt: iso(row.dueAt),
      paidAt: iso(row.paidAt),
    }));

    return this.render(context, {
      kind: 'invoice',
      title: 'Invoices',
      columns: INVOICE_COLUMNS,
      rows,
      totalRows: facet?.total?.[0]?.n ?? rows.length,
      range: { from, to },
    });
  }

  /** Payments recorded in the range, settled or not. */
  async payments(context: RequestContext, range: ExportRange): Promise<ExportedFile> {
    await this.guard(
      context,
      'payment',
      PERMISSIONS.PAYMENT_VIEW,
      PERMISSIONS.PAYMENT_EXPORT,
      range,
    );

    const { from, to } = assertRange(range);

    const [facet] = await paymentRepository.aggregate<CountedFacet<Record<string, unknown>>>(
      context,
      [
        // A pending or failed payment has no `paidAt`; recording when it was
        // attempted is what makes a failure rate visible at all.
        { $addFields: { effectiveAt: { $ifNull: ['$paidAt', '$createdAt'] } } },
        { $match: { effectiveAt: { $gte: from, $lte: to } } },
        countedFacet({ $sort: { effectiveAt: -1 } }, EXPORT_ROW_LIMIT, [
          ...IDENTIFIERS,
          {
            $lookup: {
              from: 'invoices',
              localField: 'invoiceId',
              foreignField: '_id',
              as: 'invoice',
              pipeline: [{ $project: { number: 1 } }],
            },
          },
          {
            $project: {
              reference: 1,
              status: 1,
              provider: 1,
              method: 1,
              currency: 1,
              amount: 1,
              providerFee: 1,
              verificationSource: 1,
              paidAt: 1,
              createdAt: 1,
              invoiceNumber: { $first: '$invoice.number' },
              residentCode: { $first: '$membership.residentCode' },
              unitNumber: { $first: '$property.unitNumber' },
            },
          },
        ]),
      ],
    );

    const rows: ReportRow[] = (facet?.rows ?? []).map((row) => ({
      reference: text(row.reference),
      invoiceNumber: text(row.invoiceNumber),
      residentCode: text(row.residentCode),
      unitNumber: text(row.unitNumber),
      status: text(row.status),
      provider: text(row.provider),
      method: text(row.method),
      currency: text(row.currency),
      amount: num(row.amount),
      providerFee: num(row.providerFee),
      net: num(row.amount) - num(row.providerFee),
      // How the money was CONFIRMED, not who confirmed it. A browser returning
      // to a success URL is not proof, and this column is what makes a payment
      // that was never verified server-side visible in a reconciliation.
      verifiedBy: text(row.verificationSource),
      paidAt: iso(row.paidAt),
      recordedAt: iso(row.createdAt),
    }));

    return this.render(context, {
      kind: 'payment',
      title: 'Payments',
      columns: PAYMENT_COLUMNS,
      rows,
      totalRows: facet?.total?.[0]?.n ?? rows.length,
      range: { from, to },
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Check both permissions, recording a refusal before throwing.
   *
   * View is required as well as export: export is an additional act, not a
   * substitute for being allowed to see the thing at all.
   */
  private async guard(
    context: RequestContext,
    kind: string,
    view: Permission,
    exportPermission: Permission,
    range: ExportRange,
  ): Promise<void> {
    for (const permission of [view, exportPermission]) {
      if (!can(context, permission)) {
        await auditService.recordFailure(context, {
          action: `${kind}.export.denied`,
          resource: kind,
          resourceId: 'export',
          reason: `Missing "${permission}".`,
          metadata: {
            from: range.from.toISOString(),
            to: range.to.toISOString(),
          },
        });
      }
      assertCan(context, permission);
    }
  }

  private async render(
    context: RequestContext,
    input: {
      kind: string;
      title: string;
      columns: ReportColumn[];
      rows: ReportRow[];
      totalRows: number;
      range: ExportRange;
    },
  ): Promise<ExportedFile> {
    const truncated = input.rows.length < input.totalRows;
    const { from, to } = input.range;

    const body = tableToCsv(
      {
        id: input.kind,
        label: input.title,
        columns: input.columns,
        rows: input.rows,
        totalRows: input.totalRows,
        truncated,
      },
      {
        // Three rows at the top mean a spreadsheet found in an inbox six months
        // later still says what it is, who took it and whether it is complete.
        notes: [
          `${input.title} export`,
          `Range: ${day(from)} to ${day(to)}`,
          `Exported by ${context.userId} at ${new Date().toISOString()}`,
          'Identified by resident code and unit only. Contains no names, contact details or identity numbers.',
        ],
      },
    );

    await auditService.record(context, {
      action: `${input.kind}.exported`,
      resource: input.kind,
      resourceId: 'export',
      metadata: {
        from: from.toISOString(),
        to: to.toISOString(),
        rows: input.rows.length,
        totalRows: input.totalRows,
        truncated,
      },
    });

    return {
      filename: `${input.kind}s-${day(from)}-to-${day(to)}.csv`,
      // The charset is stated so Excel honours the BOM rather than guessing.
      contentType: 'text/csv; charset=utf-8',
      body,
      rowCount: input.rows.length,
      totalRows: input.totalRows,
      truncated,
    };
  }
}

export function assertRange(range: ExportRange): ExportRange {
  const { from, to } = range;

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError('The export range is not a valid pair of dates.');
  }
  if (to.getTime() < from.getTime()) {
    throw new ValidationError('The end of the export range falls before its start.');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw new UnprocessableError(
      `An export may cover at most ${MAX_RANGE_DAYS} days. Narrow the range and run it again.`,
    );
  }

  return { from, to };
}

/** Thirty days when nothing is asked for, matching the reports. */
export function resolveExportRange(input: { from?: Date; to?: Date }): ExportRange {
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

export const financeExportService = new FinanceExportService();
export { EXPORT_ROW_LIMIT };
