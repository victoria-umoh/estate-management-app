import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { EXPORT_ROW_LIMIT } from '@/modules/report';
import { financeExportService, resolveExportRange } from '@/modules/finance';

const ExportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Export payments as a CSV.
 *
 * `payment.view` and `payment.export` are both checked in the SERVICE rather
 * than declared here. That is deliberate: the service records a refused export
 * in the audit trail before it throws, and a route-level check would reject the
 * request before anything was written. A pattern of refused exports is exactly
 * the signal worth keeping — it is somebody probing for a permission they were
 * not given.
 *
 * `report.view` alone is declared here, so an unauthenticated or entirely
 * unprivileged caller is still turned away at the edge without reaching a
 * database.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.REPORT_VIEW],
  query: ExportQuery,
  features: ['billing', 'reports'],
  // An export is heavier than a read and it leaves the building. Low enough
  // that scripted bulk extraction is visible rather than routine.
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'payments:export' },
  handler: async (ctx, { query }) => {
    const file = await financeExportService.payments(ctx, resolveExportRange(query));

    return new NextResponse(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'x-export-rows': String(file.rowCount),
        'x-export-total-rows': String(file.totalRows),
        'x-export-truncated': String(file.truncated),
        'x-export-row-limit': String(EXPORT_ROW_LIMIT),
        // Generated per request against live data; nothing should cache it.
        'cache-control': 'no-store',
      },
    });
  },
});
