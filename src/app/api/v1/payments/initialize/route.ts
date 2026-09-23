import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { paymentService } from '@/modules/finance';

/**
 * Start a payment and return a checkout URL.
 *
 * Rate limited per user: each call creates a pending row and a provider
 * transaction, so an unbounded loop would fill both.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.PAYMENT_CREATE],
  body: z.object({
    invoiceId: z.string().min(1),
    membershipId: z.string().min(1),
    email: z.string().trim().email().max(320),
  }),
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'payment:init' },
  status: 200,
  handler: async (ctx, { body }) => paymentService.initialize(ctx, body),
});
