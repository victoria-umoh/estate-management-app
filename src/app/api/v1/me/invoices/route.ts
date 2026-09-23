import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { invoiceService, paymentService } from '@/modules/finance';

/**
 * The caller's own invoices.
 *
 * No membership id is accepted from the request: the service resolves it from
 * the session. A resident-facing page that passed its own membership id would
 * let anyone read another household's dues by changing one value in the
 * browser — and the estate-wide /invoices route is behind `invoice.viewAll`,
 * which a resident does not hold.
 */
export const GET = defineRoute({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
  handler: async (ctx, { query }) => {
    const result = await invoiceService.listForCaller(ctx, query);

    return paginated({
      ...result,
      items: result.items.map((invoice) => ({
        id: invoice._id.toHexString(),
        number: invoice.number,
        status: invoice.status,
        total: invoice.total,
        amountPaid: invoice.amountPaid,
        outstanding: invoice.total - invoice.amountPaid,
        currency: invoice.currency,
        dueAt: invoice.dueAt,
        issuedAt: invoice.issuedAt ?? null,
      })),
    });
  },
});

/** Start a payment against one of the caller's own invoices. */
export const POST = defineRoute({
  body: z.object({ invoiceId: z.string().min(1) }),
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'payment:init' },
  status: 200,
  handler: async (ctx, { body }) => paymentService.initializeForCaller(ctx, body.invoiceId),
});
