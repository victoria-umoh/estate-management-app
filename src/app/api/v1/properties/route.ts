import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import {
  CreatePropertyDto,
  ListPropertiesDto,
  propertyRepository,
  propertyService,
} from '@/modules/property';

export const GET = defineRoute({
  permissions: [PERMISSIONS.PROPERTY_VIEW],
  query: ListPropertiesDto,
  handler: async (ctx, { query }) => {
    const { page, limit, search, ...filters } = query;

    const result = await propertyRepository.paginate(
      ctx,
      {
        ...filters,
        // Anchored regex so the query can still use the index, and escaped so a
        // user-supplied string cannot become a pattern.
        ...(search
          ? {
              unitNumber: {
                $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
                $options: 'i',
              },
            }
          : {}),
      },
      { page, limit },
      { sort: { street: 1, unitNumber: 1 } },
    );

    return paginated({
      ...result,
      items: result.items.map((property) => ({
        id: property._id.toHexString(),
        unitNumber: property.unitNumber,
        block: property.block,
        street: property.street,
        type: property.type,
        occupancyStatus: property.occupancyStatus,
        currentOccupantCount: property.currentOccupantCount,
      })),
    });
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.PROPERTY_CREATE],
  body: CreatePropertyDto,
  handler: async (ctx, { body }) => {
    const property = await propertyService.create(ctx, body);
    return { id: property._id.toHexString(), unitNumber: property.unitNumber };
  },
});
