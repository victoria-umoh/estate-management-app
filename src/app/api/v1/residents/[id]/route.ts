import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { residentService } from '@/modules/resident';

const Params = z.object({ id: z.string() });

export const GET = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_VIEW],
  params: Params,
  handler: async (ctx, { params }) => residentService.detail(ctx, params.id),
});

/**
 * Remove a resident from the estate.
 *
 * A soft delete: the audit trail, gate log and invoice history all name this
 * membership and must keep resolving. Refused while an occupancy or a vehicle
 * still depends on it — suspension, not deletion, is the tool for taking access
 * away from someone who is still here.
 */
export const DELETE = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_DELETE],
  params: Params,
  query: z.object({ reason: z.string().trim().min(3).max(500) }),
  idempotent: true,
  handler: async (ctx, { params, query }) => {
    await residentService.remove(ctx, params.id, query.reason);
    return { deleted: true };
  },
});
