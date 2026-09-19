import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { residentService } from '@/modules/resident';

const DecisionDto = z.object({
  approve: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_APPROVE],
  params: z.object({ id: z.string() }),
  body: DecisionDto,
  status: 200,
  handler: async (ctx, { params, body }) => {
    if (body.approve) {
      const membership = await residentService.approve(ctx, params.id);
      return { status: membership.status, residentCode: membership.residentCode };
    }

    await residentService.reject(ctx, params.id, body.reason ?? 'Not specified');
    return { status: 'suspended' };
  },
});
