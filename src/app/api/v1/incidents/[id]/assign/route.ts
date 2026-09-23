import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { incidentService } from '@/modules/incident';

export const POST = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_ASSIGN],
  params: z.object({ id: z.string() }),
  body: z.object({ assigneeMembershipId: z.string().min(1) }),
  status: 200,
  // A retried assign would otherwise move the incident's `assignedAt` and write
  // a second audit entry for one officer's single click.
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    const incident = await incidentService.assign(ctx, params.id, body.assigneeMembershipId);

    return {
      id: incident._id.toHexString(),
      status: incident.status,
      assignedToMembershipId: incident.assignedToMembershipId?.toHexString() ?? null,
      assignedAt: incident.assignedAt,
    };
  },
});
