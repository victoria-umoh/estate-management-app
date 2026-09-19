import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { propertyService } from '@/modules/property';

/** Full occupancy history, including ended relationships. */
export const GET = defineRoute({
  permissions: [PERMISSIONS.PROPERTY_VIEW],
  params: z.object({ id: z.string() }),
  handler: async (ctx, { params }) => {
    const history = await propertyService.history(ctx, params.id);

    return history.map((entry) => ({
      id: entry._id.toHexString(),
      membershipId: entry.membershipId.toHexString(),
      role: entry.role,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      endReason: entry.endReason,
      leaseStartDate: entry.leaseStartDate,
      leaseEndDate: entry.leaseEndDate,
    }));
  },
});
