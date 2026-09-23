import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { temporaryPassService } from '@/modules/temporary-pass';

/**
 * The gate's read of a temporary pass.
 *
 * Always 200 with a `usable` flag. A pass that has been used before is still
 * usable — that is the distinction from a visitor or exit pass, and the reply
 * says so by carrying the use count rather than a spent flag.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.TEMPORARY_PASS_VERIFY],
  body: z.object({ code: z.string().trim().min(4).max(12) }),
  status: 200,
  rateLimit: { key: 'user', limit: 120, window: '1m', bucket: 'temporary-pass:verify' },
  handler: async (ctx, { body }) => {
    const { usable, message, pass } = await temporaryPassService.verifyAtGate(ctx, body.code);

    return {
      usable,
      message,
      pass: pass
        ? {
            id: pass._id.toHexString(),
            code: pass.code,
            holderName: pass.holderName,
            company: pass.company ?? null,
            purpose: pass.purpose,
            vehiclePlate: pass.vehiclePlate ?? null,
            status: pass.status,
            validUntil: pass.validUntil,
            useCount: pass.useCount,
            inside: pass.inside,
          }
        : null,
    };
  },
});
