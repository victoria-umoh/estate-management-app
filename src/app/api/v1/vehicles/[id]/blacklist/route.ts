import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { vehicleService } from '@/modules/vehicle';

export const POST = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_BLACKLIST],
  params: z.object({ id: z.string() }),
  body: z.object({
    blacklisted: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const vehicle = await vehicleService.setBlacklist(
      ctx,
      params.id,
      body.blacklisted,
      body.reason,
    );
    return { status: vehicle.status };
  },
});
