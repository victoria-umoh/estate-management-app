import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { reportService } from '@/modules/report';

/**
 * The reports this caller may run.
 *
 * Returned per caller rather than as a fixed list: the screen renders what is
 * offered here, so a security administrator is shown gate activity and
 * incidents and is not handed a collections tile that would 403 on click.
 * `canView` and `canExport` are separate flags because the permissions are
 * separate — reading a figure and carrying it out of the estate's audited
 * system are different acts.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.REPORT_VIEW],
  handler: async (ctx) => ({
    reports: reportService.catalogue(ctx).map((report) => ({
      type: report.type,
      title: report.title,
      description: report.description,
      canView: report.canView,
      canExport: report.canExport,
      viewPermission: report.viewPermission,
      exportPermission: report.exportPermission,
    })),
  }),
});
