import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { invoiceService } from '@/modules/finance';

/**
 * Issue a draft invoice.
 *
 * Idempotent at the kernel, and the service refuses a second issue anyway: a
 * retried click must not put the same debt on the books twice.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.INVOICE_CREATE],
  params: z.object({ id: z.string() }),
  idempotent: true,
  status: 200,
  handler: async (ctx, { params }) => {
    const invoice = await invoiceService.issue(ctx, params.id);

    return {
      id: invoice._id.toHexString(),
      number: invoice.number,
      status: invoice.status,
      total: invoice.total,
      issuedAt: invoice.issuedAt ?? null,
    };
  },
});
