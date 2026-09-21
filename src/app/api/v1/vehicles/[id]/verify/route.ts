import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { vehicleService } from '@/modules/vehicle';

/**
 * Verify a vehicle and issue its gate credential.
 *
 * The token is returned exactly once — only its hash is stored, so it cannot be
 * retrieved later. A lost pass is reissued, not recovered.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_VERIFY],
  params: z.object({ id: z.string() }),
  body: z.object({
    ownerLabel: z.string().trim().max(60).optional(),
    unitNumber: z.string().trim().max(20).optional(),
  }),
  status: 200,
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    const { token, vehicle } = await vehicleService.verify(
      ctx,
      params.id,
      body.ownerLabel ?? 'Resident',
      body.unitNumber ?? undefined,
    );

    return { status: vehicle.status, token };
  },
});
