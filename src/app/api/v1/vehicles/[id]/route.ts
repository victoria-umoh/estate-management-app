import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { vehicleRepository, vehicleService } from '@/modules/vehicle';

const Params = z.object({ id: z.string() });

export const GET = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const vehicle = await vehicleRepository.findByIdOrFail(ctx, params.id);

    return {
      id: vehicle._id.toHexString(),
      plateNumber: vehicle.plateNumber,
      make: vehicle.make,
      model: vehicle.model,
      colour: vehicle.colour,
      year: vehicle.year ?? null,
      type: vehicle.type,
      status: vehicle.status,
      ownerMembershipId: vehicle.ownerMembershipId.toHexString(),
      driverName: vehicle.driverName ?? null,
      driverPhone: vehicle.driverPhone ?? null,
      insuranceProvider: vehicle.insuranceProvider ?? null,
      insuranceExpiryDate: vehicle.insuranceExpiryDate ?? null,
      verifiedAt: vehicle.verifiedAt ?? null,
      blacklistReason: vehicle.blacklistReason ?? null,
    };
  },
});

/**
 * Amend a vehicle.
 *
 * A changed plate reissues the gate credential, and the replacement token comes
 * back here exactly once — the same contract as verification, because only the
 * hash is stored and a lost pass is reissued rather than retrieved.
 */
export const PATCH = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_UPDATE],
  params: Params,
  body: z.object({
    plateNumber: z.string().trim().min(3).max(20).optional(),
    make: z.string().trim().min(1).max(40).optional(),
    model: z.string().trim().min(1).max(40).optional(),
    colour: z.string().trim().min(2).max(30).optional(),
    year: z.number().int().min(1900).max(2100).nullable().optional(),
    type: z.enum(['car', 'suv', 'bus', 'truck', 'motorcycle', 'tricycle', 'other']).optional(),
    driverName: z.string().trim().max(80).nullable().optional(),
    driverPhone: z.string().trim().max(20).nullable().optional(),
    insuranceProvider: z.string().trim().max(80).nullable().optional(),
    insuranceExpiryDate: z.coerce.date().nullable().optional(),
  }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const { vehicle, token } = await vehicleService.update(ctx, params.id, body);

    return {
      id: vehicle._id.toHexString(),
      plateNumber: vehicle.plateNumber,
      status: vehicle.status,
      // Present only when the plate changed and a credential had to be reissued.
      ...(token ? { credentialToken: token } : {}),
    };
  },
});

export const DELETE = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_DELETE],
  params: Params,
  query: z.object({ reason: z.string().trim().min(3).max(500) }),
  idempotent: true,
  handler: async (ctx, { params, query }) => {
    await vehicleService.remove(ctx, params.id, query.reason);
    return { deleted: true };
  },
});
