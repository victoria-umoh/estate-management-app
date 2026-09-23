import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { ReportQuery, ReportTypeParam, reportService, resolveRange } from '@/modules/report';

/**
 * Run a report.
 *
 * `report.generate` is what running costs; the report's own view permission —
 * `ledger.view`, `gateLog.view` and so on — is enforced inside the service, so
 * holding the generic permission alone opens nothing.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.REPORT_VIEW, PERMISSIONS.REPORT_GENERATE],
  params: ReportTypeParam,
  query: ReportQuery,
  // Each run is several aggregations over the estate's largest collections.
  rateLimit: { key: 'user', limit: 60, window: '5m', bucket: 'reports:run' },
  handler: async (ctx, { params, query }) =>
    reportService.run(ctx, params.type, resolveRange(query), {
      ...(query.table ? { tableId: query.table } : {}),
    }),
});
