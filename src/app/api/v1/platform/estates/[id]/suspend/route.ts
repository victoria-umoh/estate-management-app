import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { platformService } from '@/modules/platform';

/**
 * Suspend or restore an estate.
 *
 * A reason is required rather than optional. This is platform staff acting on a
 * customer's account, and "why" is the first question asked afterwards.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.PLATFORM_ESTATE_SUSPEND],
  params: z.object({ id: z.string() }),
  body: z.object({
    suspended: z.boolean(),
    reason: z.string().trim().min(4).max(500),
  }),
  idempotent: true,
  status: 200,
  handler: async (ctx, { params, body }) =>
    platformService.setSuspended(ctx, params.id, body.suspended, body.reason),
});
