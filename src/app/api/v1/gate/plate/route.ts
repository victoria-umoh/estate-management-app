import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { vehicleService } from '@/modules/vehicle';

/**
 * Plate lookup.
 *
 * The fallback when a QR will not scan — a dirty windscreen, a cracked screen,
 * a visitor who never received their pass.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.VEHICLE_VIEW],
  query: z.object({ plate: z.string().trim().min(2).max(20) }),
  rateLimit: { key: 'user', limit: 300, window: '1m', bucket: 'gate:plate' },
  handler: async (ctx, { query }) => vehicleService.lookupByPlate(ctx, query.plate),
});
