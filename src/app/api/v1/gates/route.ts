import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { gateService } from '@/modules/gate';

export const GET = defineRoute({
  permissions: [PERMISSIONS.GATE_VIEW],
  handler: async (ctx) => {
    const gates = await gateService.list(ctx);

    return gates.map((gate) => ({
      id: gate._id.toHexString(),
      name: gate.name,
      code: gate.code,
      status: gate.status,
      direction: gate.direction,
    }));
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.GATE_CREATE],
  body: z.object({
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().min(2).max(12),
    description: z.string().trim().max(400).optional(),
    direction: z.enum(['both', 'entry-only', 'exit-only']).optional(),
  }),
  handler: async (ctx, { body }) => {
    const gate = await gateService.create(ctx, body);
    return { id: gate._id.toHexString(), code: gate.code };
  },
});
