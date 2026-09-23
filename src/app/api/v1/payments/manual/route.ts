import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { paymentService } from '@/modules/finance';

/**
 * Record a payment taken outside the provider — cash, or a bank transfer.
 *
 * Behind `payment.verify` rather than `payment.create`, because this credits an
 * account on nothing but a person's word and is the obvious way to write a debt
 * off quietly. The note is mandatory and the recorder is named in the audit
 * trail.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.PAYMENT_VERIFY],
  body: z.object({
    invoiceId: z.string().min(1),
    membershipId: z.string().min(1),
    amount: z.number().int().positive(),
    note: z.string().trim().min(4).max(500),
  }),
  idempotent: true,
  handler: async (ctx, { body }) => {
    const payment = await paymentService.recordManual(ctx, body);

    return {
      id: payment._id.toHexString(),
      reference: payment.reference,
      status: payment.status,
      amount: payment.amount,
    };
  },
});
