import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { gateService } from '@/modules/gate';

/**
 * The officer's primary action: scan, decide, record.
 *
 * Always 200 with an `admitted` flag. A refused scan is an ordinary outcome the
 * officer must see, not an error — and treating it as one would make a flaky
 * connection indistinguishable from a rejected pass.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.GATE_OPERATE],
  body: z.object({
    token: z.string().min(1).max(2000),
    gateId: z.string().min(1),
    direction: z.enum(['in', 'out']),
    partySize: z.number().int().min(1).max(100).optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  status: 200,
  rateLimit: { key: 'user', limit: 600, window: '1m', bucket: 'gate:scan' },
  handler: async (ctx, { body }) => gateService.processScan(ctx, body),
});
