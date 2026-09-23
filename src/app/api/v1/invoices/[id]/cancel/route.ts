import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { invoiceService } from '@/modules/finance';

export const POST = defineRoute({
  permissions: [PERMISSIONS.INVOICE_CANCEL],
  params: z.object({ id: z.string() }),
  // A reason is required rather than optional: cancelling a debt is exactly the
  // action whose justification someone will want to read a year later.
  body: z.object({ reason: z.string().trim().min(4).max(500) }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const invoice = await invoiceService.cancel(ctx, params.id, body.reason);

    return {
      id: invoice._id.toHexString(),
      number: invoice.number,
      status: invoice.status,
    };
  },
});
