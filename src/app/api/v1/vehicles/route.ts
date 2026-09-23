import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';
import { vehicleRepository, vehicleService } from '@/modules/vehicle';

const RegisterDto = z.object({
  ownerMembershipId: z.string().min(1),
  plateNumber: z.string().trim().min(3).max(20),
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(40),
  colour: z.string().trim().min(2).max(30),
  year: z.number().int().min(1900).max(2100).optional(),
  type: z.enum(['car', 'suv', 'bus', 'truck', 'motorcycle', 'tricycle', 'other']).optional(),
  driverName: z.string().trim().max(80).optional(),
  driverPhone: z.string().trim().max(20).optional(),
  insuranceProvider: z.string().trim().max(80).optional(),
  insuranceExpiryDate: z.coerce.date().optional(),
});

export const GET = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_VIEW],
  query: z.object({
    status: z
      .enum(['pending', 'active', 'suspended', 'blacklisted', 'expired', 'removed'])
      .optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;

    // Residents hold `vehicle.view` for their own cars. The wide read joins a
    // plate to an owner and thence to a unit number, for the whole estate.
    const scope = await meService.narrowUnless(
      ctx,
      PERMISSIONS.VEHICLE_VIEW_ALL,
      'ownerMembershipId',
    );

    const result = await vehicleRepository.paginate(ctx, { ...filters, ...scope }, { page, limit });

    return paginated({
      ...result,
      items: result.items.map((vehicle) => ({
        id: vehicle._id.toHexString(),
        plateNumber: vehicle.plateNumber,
        description: `${vehicle.colour} ${vehicle.make} ${vehicle.model}`,
        type: vehicle.type,
        status: vehicle.status,
        ownerMembershipId: vehicle.ownerMembershipId.toHexString(),
      })),
    });
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_CREATE],
  body: RegisterDto,
  handler: async (ctx, { body }) => {
    const vehicle = await vehicleService.register(ctx, body);
    return {
      id: vehicle._id.toHexString(),
      plateNumber: vehicle.plateNumber,
      status: vehicle.status,
    };
  },
});
