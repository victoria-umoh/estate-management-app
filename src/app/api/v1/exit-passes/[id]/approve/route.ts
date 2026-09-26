import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { exitPassService } from '@/modules/exit-pass';

/**
 * Approve or refuse a removal.
 *
 * One endpoint for both outcomes because they are one decision, made once, by
 * the same person — and because a refusal that has its own endpoint tends to be
 * the one nobody wires up.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.EXIT_PASS_APPROVE],
  params: z.object({ id: z.string() }),
  body: z.object({
    approved: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    if (!body.approved) {
      const pass = await exitPassService.reject(ctx, params.id, body.reason ?? 'No reason given.');

      return { id: pass._id.toHexString(), status: pass.status, token: null };
    }

    const { pass, token } = await exitPassService.approve(ctx, params.id, body.reason);

    return {
      id: pass._id.toHexString(),
      status: pass.status,
      manifestLockedAt: pass.manifestLockedAt,
      validUntil: pass.validUntil,
      // Returned once: the QR the carrier presents at the gate.
      token,
    };
  },
});
