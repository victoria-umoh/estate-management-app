import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { propertyService } from '@/modules/property';
import { serializeTenancy } from '../serialize';

const Params = z.object({ id: z.string() });

export const GET = defineRoute({
  params: Params,
  handler: async (ctx, { params }) =>
    serializeTenancy(await propertyService.tenancy(ctx, params.id)),
});

/**
 * Exit: the last step of the lifecycle.
 *
 * DELETE ends the tenancy; it does not delete it. The row stays because gate
 * logs and invoices from that period point back at it, which is exactly what a
 * dispute six months later needs.
 */
export const DELETE = defineRoute({
  params: Params,
  query: z.object({
    endReason: z.enum(['lease-ended', 'evicted', 'moved-out', 'corrected']).default('lease-ended'),
  }),
  idempotent: true,
  handler: async (ctx, { params, query }) => {
    await propertyService.endOccupancy(ctx, params.id, query.endReason);
    return { ended: true, endReason: query.endReason };
  },
});
