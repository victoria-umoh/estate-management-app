import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { invoiceService } from '@/modules/finance';

const STATUSES = ['draft', 'issued', 'partially-paid', 'paid', 'overdue', 'cancelled'] as const;

export const GET = defineRoute({
  permissions: [PERMISSIONS.INVOICE_VIEW_ALL],
  query: z.object({
    status: z.enum(STATUSES).optional(),
    membershipId: z.string().optional(),
    propertyId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await invoiceService.list(ctx, filters, { page, limit });

    return paginated({
      ...result,
      items: result.items.map((invoice) => ({
        id: invoice._id.toHexString(),
        number: invoice.number,
        membershipId: invoice.membershipId.toHexString(),
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

export const POST = defineRoute({
  permissions: [PERMISSIONS.INVOICE_CREATE],
  body: z.object({
    membershipId: z.string().min(1),
    propertyId: z.string().optional(),
    lines: z
      .array(
        z.object({
          feeCategoryId: z.string().optional(),
          description: z.string().trim().min(2).max(200),
          quantity: z.number().int().positive().max(1000).optional(),
          // Minor units only — a fractional amount means a conversion upstream
          // was left unrounded.
          unitAmount: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(50),
    dueAt: z.coerce.date(),
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
    notes: z.string().trim().max(1000).optional(),
    currency: z.string().trim().length(3).optional(),
  }),
  handler: async (ctx, { body }) => {
    const invoice = await invoiceService.create(ctx, body);

    return {
      id: invoice._id.toHexString(),
      number: invoice.number,
      status: invoice.status,
      total: invoice.total,
    };
  },
});
