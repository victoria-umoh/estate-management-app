import { defineRoute } from '@/core/http';
import { dashboardService } from '@/modules/dashboard';

/**
 * The landing screen's numbers.
 *
 * No permission is declared: the service decides which blocks to compute from
 * what the caller can see, and returns only those. Gating the whole route would
 * mean a resident meets a 403 on the first screen after signing in.
 */
export const GET = defineRoute({
  handler: async (ctx) => dashboardService.load(ctx),
});
