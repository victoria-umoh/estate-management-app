import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { exitPassService } from '@/modules/exit-pass';

/**
 * Withdraw a pass.
 *
 * No permission is declared because the rule is not a permission: the household
 * that raised the pass may withdraw it, and so may anyone who could have
 * approved it. The service owns that test — declaring the staff permission here
 * would lock a resident out of cancelling their own removal.
 */
export const POST = defineRoute({
  params: z.object({ id: z.string() }),
  body: z.object({ reason: z.string().trim().max(500).optional() }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const pass = await exitPassService.revoke(ctx, params.id, body.reason);
    return { id: pass._id.toHexString(), status: pass.status };
  },
});
