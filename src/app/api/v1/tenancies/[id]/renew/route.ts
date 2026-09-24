import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { RenewTenancyDto, propertyService } from '@/modules/property';
import { serializeTenancy } from '../../serialize';

/**
 * Extend the lease.
 *
 * Idempotent, because a retry after a timeout would otherwise append a second
 * superseded term and make the history read as two renewals where there was one.
 */
export const POST = defineRoute({
  params: z.object({ id: z.string() }),
  body: RenewTenancyDto,
  idempotent: true,
  status: 200,
  handler: async (ctx, { params, body }) =>
    serializeTenancy(await propertyService.renewTenancy(ctx, params.id, body)),
});
