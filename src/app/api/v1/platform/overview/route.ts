import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { platformService } from '@/modules/platform';

export const GET = defineRoute({
  permissions: [PERMISSIONS.PLATFORM_ANALYTICS_VIEW],
  handler: async (ctx) => platformService.overview(ctx),
});
