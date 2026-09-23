import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { paymentService } from '@/modules/finance';

/**
 * Check a payment after the provider redirects the browser back.
 *
 * The redirect itself proves nothing — it is a URL the payer controls — so the
 * reference is used only to look the payment up, and the answer comes from
 * asking the provider directly. The webhook remains the authoritative path;
 * this exists so the page has something truthful to show immediately.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.PAYMENT_VIEW],
  query: z.object({ reference: z.string().trim().min(6).max(80) }),
  handler: async (ctx, { query }) => {
    const payment = await paymentService.verify(ctx, query.reference);

    return {
      reference: payment.reference,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      paidAt: payment.paidAt ?? null,
      invoiceId: payment.invoiceId?.toHexString() ?? null,
    };
  },
});
