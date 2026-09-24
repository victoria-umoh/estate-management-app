import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { auditExportService } from '@/modules/audit';
import { EXPORT_ROW_LIMIT } from '@/modules/report';

const AuditExportQuery = z.object({
  action: z.string().trim().max(80).optional(),
  resource: z.string().trim().max(80).optional(),
  resourceId: z.string().trim().max(64).optional(),
  actorId: z.string().trim().max(64).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Export the audit trail as a CSV.
 *
 * `audit.view` and `audit.export` are both checked in the SERVICE, not
 * declared here, so that a refusal is written to the trail before it throws.
 * That matters more on this endpoint than on any other: somebody without
 * `audit.export` attempting to take the evidence out of the system is the
 * single most interesting line the trail can hold, and a route-level check
 * would discard the request before it was recorded.
 *
 * The file carries field NAMES, never before and after values — see the
 * service for why. `audit.export` is not a way around the redaction the trail
 * applies on the way in.
 *
 * The limit is tighter than the other exports. An estate has one audit trail
 * and nobody needs twenty copies of it an hour.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.REPORT_VIEW],
  query: AuditExportQuery,
  features: ['audit-export'],
  rateLimit: { key: 'user', limit: 6, window: '1h', bucket: 'audit:export' },
  handler: async (ctx, { query }) => {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 30 * 86_400_000);

    const file = await auditExportService.export(ctx, {
      ...(query.action ? { action: query.action } : {}),
      ...(query.resource ? { resource: query.resource } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      from,
      to,
    });

    return new NextResponse(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'x-export-rows': String(file.rowCount),
        'x-export-total-rows': String(file.totalRows),
        'x-export-truncated': String(file.truncated),
        'x-export-row-limit': String(EXPORT_ROW_LIMIT),
        'cache-control': 'no-store',
      },
    });
  },
});
