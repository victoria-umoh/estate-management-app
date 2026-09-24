import { defineRoute, paginated } from '@/core/http';
import { ListTenanciesDto, propertyService } from '@/modules/property';
import { serializeTenancy } from './serialize';

/**
 * Tenancies across the estate.
 *
 * No permission is declared here: `tenant.view` is asserted in the service, so
 * the same check applies however the service is reached — from this route, from
 * the admin screen, or from a future job.
 */
export const GET = defineRoute({
  query: ListTenanciesDto,
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await propertyService.tenanciesForDisplay(ctx, filters, { page, limit });

    return paginated({ ...result, items: result.items.map(serializeTenancy) });
  },
});
