import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { serviceRequestService } from '@/modules/service-request';

export const POST = defineRoute({
  permissions: [PERMISSIONS.SERVICE_REQUEST_ASSIGN],
  params: z.object({ id: z.string() }),
  // Either is enough on its own: a ticket routed to "Maintenance" before anyone
  // has been named is a real state, and the service accepts it.
  body: z
    .object({
      assigneeMembershipId: z.string().min(1).optional(),
      department: z.string().trim().min(1).max(80).optional(),
    })
    .refine(
      (value) => value.assigneeMembershipId !== undefined || value.department !== undefined,
      { message: 'Provide an assignee, a department, or both.' },
    ),
  status: 200,
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    const request = await serviceRequestService.assign(ctx, params.id, body);

    return {
      id: request._id.toHexString(),
      status: request.status,
      assignedToMembershipId: request.assignedToMembershipId?.toHexString() ?? null,
      assignedDepartment: request.assignedDepartment ?? null,
      assignedAt: request.assignedAt,
    };
  },
});
