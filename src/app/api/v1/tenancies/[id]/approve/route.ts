import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { propertyService } from '@/modules/property';
import { serializeTenancy } from '../../serialize';

/** Idempotent: a retried approval must not stamp a second approver over the first. */
export const POST = defineRoute({
  params: z.object({ id: z.string() }),
  idempotent: true,
  status: 200,
  handler: async (ctx, { params }) =>
    serializeTenancy(await propertyService.approveTenancy(ctx, params.id)),
});
