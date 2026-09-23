import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { subscriptionService } from '@/modules/subscription';

export const GET = defineRoute({
  permissions: [PERMISSIONS.SUBSCRIPTION_VIEW],
  handler: async (ctx) => subscriptionService.current(ctx),
});

/**
 * Change plan.
 *
 * Idempotent, because a retried upgrade after a timeout must not be billed
 * twice once this is wired to the payment provider.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.SUBSCRIPTION_MANAGE],
  body: z.object({
    planCode: z.enum(['starter', 'professional', 'enterprise']),
    billingPeriod: z.enum(['monthly', 'annual']),
  }),
  idempotent: true,
  status: 200,
  handler: async (ctx, { body }) => subscriptionService.subscribe(ctx, body),
});
