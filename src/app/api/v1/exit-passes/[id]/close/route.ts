import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { exitPassService } from '@/modules/exit-pass';

/**
 * The goods have left. Close the pass.
 *
 * Single-use, enforced in the service: a second call against the same pass is a
 * 409, whichever gate it comes from.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.EXIT_PASS_CLOSE],
  params: z.object({ id: z.string() }),
  body: z.object({
    gateId: z.string().min(1),
    notes: z.string().trim().max(500).optional(),
  }),
  status: 200,
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    const pass = await exitPassService.close(ctx, params.id, body);

    return {
      id: pass._id.toHexString(),
      status: pass.status,
      usedAt: pass.usedAt,
      usedGateId: pass.usedGateId?.toHexString() ?? null,
    };
  },
});
