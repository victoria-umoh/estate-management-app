import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { incidentService } from '@/modules/incident';

/**
 * Only the two free-form moves live here. `assigned`, `resolved`, `escalated`
 * and `closed` each carry their own required data and their own permission, so
 * they have their own routes rather than being reachable by posting a string.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_UPDATE],
  params: z.object({ id: z.string() }),
  body: z.object({ status: z.enum(['open', 'investigating']) }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const incident = await incidentService.setStatus(ctx, params.id, body.status);
    return { id: incident._id.toHexString(), status: incident.status };
  },
});
