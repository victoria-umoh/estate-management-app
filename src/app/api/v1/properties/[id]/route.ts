import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import {
  AssignOccupantDto,
  DeleteReasonDto,
  propertyOccupancyRepository,
  propertyRepository,
  propertyService,
} from '@/modules/property';

const Params = z.object({ id: z.string() });

export const GET = defineRoute({
  permissions: [PERMISSIONS.PROPERTY_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const property = await propertyRepository.findByIdOrFail(ctx, params.id);
    const occupants = await propertyOccupancyRepository.findCurrentOccupants(ctx, params.id);

    return {
      id: property._id.toHexString(),
      unitNumber: property.unitNumber,
      block: property.block,
      street: property.street,
      type: property.type,
      occupancyStatus: property.occupancyStatus,
      bedrooms: property.bedrooms,
      maxOccupants: property.maxOccupants,
      currentOccupantCount: property.currentOccupantCount,
      registeredAt: property.registeredAt,
      occupants: occupants.map((entry) => ({
        id: entry._id.toHexString(),
        membershipId: entry.membershipId.toHexString(),
        role: entry.role,
        startedAt: entry.startedAt,
        leaseEndDate: entry.leaseEndDate,
      })),
    };
  },
});

export const POST = defineRoute({
  params: Params,
  body: AssignOccupantDto,
  // Permission is checked inside the service, which knows whether this is a
  // tenancy (tenant.create) or an ownership change (property.update).
  handler: async (ctx, { params, body }) => {
    const occupancy = await propertyService.assignOccupant(ctx, {
      propertyId: params.id,
      ...body,
    });
    return { id: occupancy._id.toHexString(), role: occupancy.role };
  },
});

/**
 * Remove a property from the register.
 *
 * A soft delete, refused while anyone still holds or occupies the unit. The
 * reason rides as a query parameter rather than a body because a DELETE body is
 * poorly supported by intermediaries, and every delete here records why.
 */
export const DELETE = defineRoute({
  permissions: [PERMISSIONS.PROPERTY_DELETE],
  params: Params,
  query: DeleteReasonDto,
  idempotent: true,
  handler: async (ctx, { params, query }) => {
    await propertyService.remove(ctx, params.id, query.reason);
    return { deleted: true };
  },
});
