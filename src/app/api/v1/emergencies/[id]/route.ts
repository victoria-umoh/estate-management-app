import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { emergencyService } from '@/modules/emergency';
import { meService } from '@/modules/me';

/**
 * Respond to an emergency.
 *
 * The responder is the caller, resolved from the session. It used to be taken
 * from the request body, which was wrong twice over: it let a client claim
 * someone else had attended an incident — the one record that matters most
 * afterwards — and it forced the browser to know its own membership id, which
 * it has no reliable way to learn.
 */
const ActionDto = z.discriminatedUnion('action', [
  z.object({ action: z.literal('acknowledge') }),
  z.object({ action: z.literal('responding') }),
  z.object({
    action: z.literal('resolve'),
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
          await meService.membershipId(ctx),
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
          await meService.membershipId(ctx),
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
