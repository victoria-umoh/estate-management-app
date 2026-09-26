import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { gateService } from '@/modules/gate';

/** Record a refusal the officer made on their own judgement. */
export const POST = defineRoute({
  permissions: [PERMISSIONS.GATE_OPERATE],
  body: z.object({
    gateId: z.string().min(1),
    label: z.string().trim().min(2).max(160),
    reason: z.string().trim().min(2).max(120),
    notes: z.string().trim().max(1000).optional(),
    direction: z.enum(['in', 'out']).optional(),
  }),
  status: 200,
  handler: async (ctx, { body }) => {
    await gateService.recordManualDenial(ctx, body);
    return { recorded: true };
  },
});
