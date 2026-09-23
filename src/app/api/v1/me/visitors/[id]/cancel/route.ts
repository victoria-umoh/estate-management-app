import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';

/**
 * Cancel a pass the caller hosts.
 *
 * A pass belonging to another household is a 404, not a 403 — confirming it
 * exists would let someone enumerate live codes.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.VISITOR_CANCEL],
  params: z.object({ id: z.string() }),
  body: z.object({ reason: z.string().trim().max(200).optional() }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    await meService.cancelVisitorPass(ctx, params.id, body.reason);
    return { cancelled: true };
  },
});
