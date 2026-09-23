import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { temporaryPassService } from '@/modules/temporary-pass';

/** Withdraw a pass before its window closes. */
export const POST = defineRoute({
  permissions: [PERMISSIONS.TEMPORARY_PASS_REVOKE],
  params: z.object({ id: z.string() }),
  body: z.object({ reason: z.string().trim().min(2).max(500) }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const pass = await temporaryPassService.revoke(ctx, params.id, body.reason);

    return {
      id: pass._id.toHexString(),
      status: pass.status,
      revokedAt: pass.revokedAt,
    };
  },
});
