import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';

export const GET = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_VIEW],
  handler: async (ctx) => {
    const vehicles = await meService.vehicles(ctx);

    return vehicles.map((vehicle) => ({
      id: vehicle._id.toHexString(),
      plateNumber: vehicle.plateNumber,
      make: vehicle.make,
      model: vehicle.model,
      colour: vehicle.colour,
      year: vehicle.year ?? null,
      type: vehicle.type,
      status: vehicle.status,
      // Derived from status rather than a separate flag, so the two can never
      // disagree about whether this car gets through the gate.
      blacklisted: vehicle.status === 'blacklisted',
      blacklistReason: vehicle.blacklistReason ?? null,
      driverName: vehicle.driverName ?? null,
      driverPhone: vehicle.driverPhone ?? null,
      insuranceProvider: vehicle.insuranceProvider ?? null,
      insuranceExpiryDate: vehicle.insuranceExpiryDate ?? null,
    }));
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_CREATE],
  body: z.object({
    plateNumber: z.string().trim().min(3).max(20),
    make: z.string().trim().min(1).max(40),
    model: z.string().trim().min(1).max(40),
    colour: z.string().trim().min(1).max(30),
    year: z.number().int().min(1950).max(2100).optional(),
    type: z.enum(['car', 'suv', 'bus', 'truck', 'motorcycle', 'other']).optional(),
    driverName: z.string().trim().max(120).optional(),
    driverPhone: z.string().trim().max(20).optional(),
    insuranceProvider: z.string().trim().max(80).optional(),
    insuranceExpiryDate: z.coerce.date().optional(),
  }),
  handler: async (ctx, { body }) => {
    const vehicle = await meService.registerVehicle(ctx, body);

    return {
      id: vehicle._id.toHexString(),
      plateNumber: vehicle.plateNumber,
      status: vehicle.status,
    };
  },
});
