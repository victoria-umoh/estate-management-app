import { Types } from 'mongoose';
import { UnprocessableError, ValidationError } from '@/core/errors';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import { assertTenantContext, type RequestContext } from '@/core/tenancy';
import { tableToCsv } from '@/modules/report/csv';
import { EXPORT_ROW_LIMIT, type ReportColumn, type ReportRow } from '@/modules/report/types';
import { auditService } from './service';
import { AuditLogModel, type AuditLogDoc } from './schema';

/**
 * Taking the audit trail out of the system.
 *
 * This is the most dangerous export in the product, for a reason that is easy
 * to miss: the audit trail is the one collection that deliberately records what
 * happened to sensitive data. It does that WITHOUT storing the data itself —
 * `diffRecords` reduces a NIN to `[REDACTED]`/`[SET]`, `redactMetadata` does
 * the same to metadata — so the trail can say that a national identity number
 * changed without becoming a second database of national identity numbers.
 *
 * An export that flattened `changes` and `metadata` into cells would undo none
 * of that redaction directly, but it would carry every UNREDACTED value in
 * those blobs — a plate number, a location, an address, a masked-but-recoverable
 * fragment — out of the audited system in bulk, and it would do so through a
 * code path where a future field added to metadata is exported automatically
 * and silently. So this export does not emit values at all. It emits the NAMES
 * of the fields that changed, which is what an auditor reconstructing a
 * sequence of events actually needs, and points anyone who needs the content at
 * the on-screen trail, where each read is itself a single, attributable act.
 *
 * The CSV is written by `report/csv` — the one writer in this codebase that
 * emits a BOM, uses CRLF, quotes properly and neutralises formulas. An audit
 * entry whose `reason` begins with `=` must not become a live formula in
 * whoever's spreadsheet opens the file.
 */

export interface AuditExportFilters {
  action?: string;
  resource?: string;
  resourceId?: string;
  actorId?: string;
  outcome?: 'success' | 'failure';
  from: Date;
  to: Date;
}

export interface ExportedAudit {
  filename: string;
  contentType: string;
  body: string;
  rowCount: number;
  totalRows: number;
  truncated: boolean;
}

/** A year and a day — long enough for an annual review, bounded all the same. */
const MAX_RANGE_DAYS = 366;

const COLUMNS: ReportColumn[] = [
  { key: 'at', label: 'When', format: 'datetime' },
  { key: 'action', label: 'Action', format: 'text' },
  { key: 'resource', label: 'Resource', format: 'text' },
  { key: 'resourceId', label: 'Record', format: 'text' },
  { key: 'outcome', label: 'Outcome', format: 'text' },
  { key: 'reason', label: 'Reason', format: 'text' },
  { key: 'actor', label: 'Actor', format: 'text' },
  { key: 'actorRoles', label: 'Actor roles', format: 'text' },
  { key: 'ip', label: 'Source address', format: 'text' },
  { key: 'correlationId', label: 'Correlation', format: 'text' },
  {
    key: 'changedFields',
    label: 'Fields changed',
    format: 'text',
  },
];

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class AuditExportService {
  /**
   * Export a slice of the trail.
   *
   * Gated on `audit.view` AND `audit.export`, both checked here rather than at
   * the route, so that a refusal is itself recorded before it throws. A refused
   * audit export is among the most interesting lines the trail can hold: it is
   * somebody without the permission trying to take the evidence out.
   */
  async export(context: RequestContext, filters: AuditExportFilters): Promise<ExportedAudit> {
    assertTenantContext(context);

    for (const permission of [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT]) {
      if (!can(context, permission)) {
        await auditService.recordFailure(context, {
          action: 'audit.export.denied',
          resource: 'audit',
          resourceId: 'export',
          reason: `Missing "${permission}".`,
          metadata: {
            from: filters.from.toISOString(),
            to: filters.to.toISOString(),
          },
        });
      }
      assertCan(context, permission);
    }

    const { from, to } = assertRange(filters);

    // Built here rather than reusing `AuditRepository.search`: that method
    // paginates for a screen, and an export wants one capped pass plus the full
    // count so the file can say whether it is complete.
    const filter: Record<string, unknown> = {
      estateId: new Types.ObjectId(context.estateId),
      createdAt: { $gte: from, $lte: to },
    };

    if (filters.action) filter.action = filters.action;
    if (filters.resource) filter.resource = filters.resource;
    if (filters.resourceId) filter.resourceId = filters.resourceId;
    if (filters.outcome) filter.outcome = filters.outcome;
    if (filters.actorId && Types.ObjectId.isValid(filters.actorId)) {
      filter.actorId = new Types.ObjectId(filters.actorId);
    }

    const [entries, totalRows] = await Promise.all([
      AuditLogModel.find(filter)
        .sort({ createdAt: -1 })
        .limit(EXPORT_ROW_LIMIT)
        // An explicit projection, not a deny-list. `metadata` and `changes` are
        // never fetched, so a field added to either later cannot reach a
        // spreadsheet by being forgotten here. Only the field NAMES from
        // `changes` are wanted, and those come from `changes.field`.
        .select({
          createdAt: 1,
          action: 1,
          resource: 1,
          resourceId: 1,
          outcome: 1,
          reason: 1,
          actorLabel: 1,
          actorRoles: 1,
          ip: 1,
          correlationId: 1,
          'changes.field': 1,
        })
        .lean<AuditLogDoc[]>()
        .exec(),
      AuditLogModel.countDocuments(filter).exec(),
    ]);

    const rows: ReportRow[] = entries.map((entry) => ({
      at: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : '',
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? '',
      outcome: entry.outcome,
      reason: entry.reason ?? '',
      actor: entry.actorLabel,
      actorRoles: (entry.actorRoles ?? []).join(' '),
      ip: entry.ip ?? '',
      correlationId: entry.correlationId ?? '',
      // Names only. The before and after values stay in the system, where
      // reading them is a single act against a single record rather than a
      // bulk extraction.
      changedFields: (entry.changes ?? []).map((change) => change.field).join(' '),
    }));

    const truncated = rows.length < totalRows;

    const body = tableToCsv(
      {
        id: 'audit',
        label: 'Audit trail',
        columns: COLUMNS,
        rows,
        totalRows,
        truncated,
      },
      {
        notes: [
          'Audit trail export',
          `Range: ${day(from)} to ${day(to)}`,
          `Exported by ${context.userId} at ${new Date().toISOString()}`,
          'Field names only: the before and after values, including any this trail redacted, are deliberately not exported. Read them one record at a time in the audit screen.',
        ],
      },
    );

    await auditService.record(context, {
      action: 'audit.exported',
      resource: 'audit',
      resourceId: 'export',
      metadata: {
        from: from.toISOString(),
        to: to.toISOString(),
        rows: rows.length,
        totalRows,
        truncated,
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.resource ? { resource: filters.resource } : {}),
        ...(filters.outcome ? { outcome: filters.outcome } : {}),
      },
    });

    return {
      filename: `audit-${day(from)}-to-${day(to)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body,
      rowCount: rows.length,
      totalRows,
      truncated,
    };
  }
}

function assertRange(range: { from: Date; to: Date }): { from: Date; to: Date } {
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

export const auditExportService = new AuditExportService();
