import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { emergencyService } from '@/modules/emergency';

const ActionDto = z.discriminatedUnion('action', [
  z.object({ action: z.literal('acknowledge'), responderMembershipId: z.string().min(1) }),
  z.object({ action: z.literal('responding') }),
  z.object({
    action: z.literal('resolve'),
    responderMembershipId: z.string().min(1),
    outcome: z.string().trim().min(2).max(2000),
    falseAlarm: z.boolean().optional(),
  }),
]);

export const POST = defineRoute({
  permissions: [PERMISSIONS.EMERGENCY_ACKNOWLEDGE],
  params: z.object({ id: z.string() }),
  body: ActionDto,
  status: 200,
  handler: async (ctx, { params, body }) => {
    switch (body.action) {
      case 'acknowledge': {
        const emergency = await emergencyService.acknowledge(
          ctx,
          params.id,
          body.responderMembershipId,
        );
        return { status: emergency.status, responseTimeSeconds: emergency.responseTimeSeconds };
      }
      case 'responding': {
        const emergency = await emergencyService.markResponding(ctx, params.id);
        return { status: emergency.status };
      }
      case 'resolve': {
        const emergency = await emergencyService.resolve(
          ctx,
          params.id,
          body.responderMembershipId,
          {
            outcome: body.outcome,
            ...(body.falseAlarm !== undefined ? { falseAlarm: body.falseAlarm } : {}),
          },
        );
        return { status: emergency.status };
      }
    }
  },
});
