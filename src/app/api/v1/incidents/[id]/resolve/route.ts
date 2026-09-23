import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { incidentService } from '@/modules/incident';
import { meService } from '@/modules/me';

export const POST = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_RESOLVE],
  params: z.object({ id: z.string() }),
  body: z.object({ resolution: z.string().trim().min(4).max(5000) }),
  status: 200,
  // A retry would otherwise overwrite `resolvedAt` and re-attribute the
  // resolution, which is the field a service report is built from.
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    // Taken from the session, never the body: who resolved an incident is an
    // attribution that a caller must not be able to assign to someone else.
    const resolverMembershipId = await meService.membershipId(ctx);

    const incident = await incidentService.resolve(
      ctx,
      params.id,
      resolverMembershipId,
      body.resolution,
    );

    return {
      id: incident._id.toHexString(),
      status: incident.status,
      resolution: incident.resolution,
      resolvedAt: incident.resolvedAt,
      resolvedByMembershipId: incident.resolvedByMembershipId?.toHexString() ?? null,
    };
  },
});
