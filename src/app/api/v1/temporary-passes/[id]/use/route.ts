import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { temporaryPassService } from '@/modules/temporary-pass';

/**
 * Record a passage.
 *
 * Deliberately not a "close": the pass stays active and is used again tomorrow.
 * What changes is the count and whether the holder is inside.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.TEMPORARY_PASS_VERIFY],
  params: z.object({ id: z.string() }),
  body: z.object({
    gateId: z.string().min(1),
    direction: z.enum(['in', 'out']),
    notes: z.string().trim().max(500).optional(),
  }),
  status: 200,
  rateLimit: { key: 'user', limit: 300, window: '1m', bucket: 'temporary-pass:use' },
  handler: async (ctx, { params, body }) => {
    const pass = await temporaryPassService.recordUse(ctx, params.id, body);

    return {
      id: pass._id.toHexString(),
      status: pass.status,
      useCount: pass.useCount,
      inside: pass.inside,
      lastUsedAt: pass.lastUsedAt,
      validUntil: pass.validUntil,
    };
  },
});
