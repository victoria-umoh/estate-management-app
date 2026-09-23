import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { exitPassService } from '@/modules/exit-pass';

/**
 * The gate's read of an exit pass.
 *
 * Always 200 with a `usable` flag, and the manifest is returned even when the
 * answer is no: the officer needs to see what was declared in order to explain
 * the refusal to the person holding the boxes.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.EXIT_PASS_VERIFY],
  body: z.object({ code: z.string().trim().min(4).max(12) }),
  status: 200,
  rateLimit: { key: 'user', limit: 120, window: '1m', bucket: 'exit-pass:verify' },
  handler: async (ctx, { body }) => {
    const { usable, message, pass } = await exitPassService.verifyAtGate(ctx, body.code);

    return {
      usable,
      message,
      pass: pass
        ? {
            id: pass._id.toHexString(),
            code: pass.code,
            carrierName: pass.carrierName,
            carrierPhone: pass.carrierPhone ?? null,
            destination: pass.destination,
            reason: pass.reason,
            vehiclePlate: pass.vehiclePlate ?? null,
            // The whole point of the endpoint: what the officer checks the load
            // against before letting anything through the barrier.
            items: pass.items,
            status: pass.status,
            validUntil: pass.validUntil,
          }
        : null,
    };
  },
});
