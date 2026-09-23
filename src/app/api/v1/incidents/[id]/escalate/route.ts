import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { incidentService } from '@/modules/incident';

export const POST = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_ESCALATE],
  params: z.object({ id: z.string() }),
  // A reason is required: escalation raises severity, and the justification is
  // what makes that defensible when the record is read back later.
  body: z.object({ reason: z.string().trim().min(4).max(1000) }),
  status: 200,
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    const incident = await incidentService.escalate(ctx, params.id, body.reason);

    return {
      id: incident._id.toHexString(),
      status: incident.status,
      severity: incident.severity,
      escalatedAt: incident.escalatedAt,
      escalationReason: incident.escalationReason,
    };
  },
});
