import { NextResponse } from 'next/server';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import {
  EXPORT_ROW_LIMIT,
  ReportExportQuery,
  ReportTypeParam,
  reportService,
  resolveRange,
} from '@/modules/report';

/**
 * Export a report as a file.
 *
 * `report.export` and the report's own export permission are both checked in
 * the SERVICE rather than declared here. That is deliberate: the service
 * records a refused export in the audit trail before it throws, and a
 * route-level check would reject the request before anything was written. A
 * pattern of refused exports is exactly the signal worth keeping.
 *
 * The row cap is stated on the response as well as inside the file, so a
 * client never has to guess whether it received everything.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.REPORT_VIEW],
  params: ReportTypeParam,
  query: ReportExportQuery,
  // An export is heavier than a read and leaves the building. The ceiling is
  // low enough that scripted bulk extraction is visible rather than routine.
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'reports:export' },
  handler: async (ctx, { params, query }) => {
    const file = await reportService.export(ctx, params.type, resolveRange(query), {
      tableId: query.table,
      format: query.format,
    });

    return new NextResponse(file.body, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'x-report-rows': String(file.rowCount),
        'x-report-total-rows': String(file.totalRows),
        'x-report-truncated': String(file.truncated),
        'x-report-row-limit': String(EXPORT_ROW_LIMIT),
        // Generated per request against live data; nothing should cache it.
        'cache-control': 'no-store',
      },
    });
  },
});
