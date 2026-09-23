import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';
import { serviceRequestRepository, serviceRequestService } from '@/modules/service-request';

const Params = z.object({ id: z.string() });

export const GET = defineRoute({
  permissions: [PERMISSIONS.SERVICE_REQUEST_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const request = await serviceRequestRepository.findByIdOrFail(ctx, params.id);

    return {
      id: request._id.toHexString(),
      ticketNumber: request.ticketNumber,
      category: request.category,
      priority: request.priority,
      subject: request.subject,
      description: request.description,
      status: request.status,
      location: request.location ?? null,
      propertyId: request.propertyId?.toHexString() ?? null,
      attachmentIds: request.attachmentIds.map((id) => id.toHexString()),
      requestedByMembershipId: request.requestedByMembershipId.toHexString(),
      assignedToMembershipId: request.assignedToMembershipId?.toHexString() ?? null,
      assignedDepartment: request.assignedDepartment ?? null,
      assignedAt: request.assignedAt ?? null,
      dueAt: request.dueAt,
      // Computed for display rather than stored, so it is never stale.
      overdue:
        request.dueAt.getTime() < Date.now() && !['resolved', 'closed'].includes(request.status),
      escalatedAt: request.escalatedAt ?? null,
      resolution: request.resolution ?? null,
      resolvedAt: request.resolvedAt ?? null,
      resolvedByMembershipId: request.resolvedByMembershipId?.toHexString() ?? null,
      closedAt: request.closedAt ?? null,
      satisfactionRating: request.satisfactionRating ?? null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  },
});

/**
 * Close a ticket.
 *
 * No permission is declared because the rule is not a permission: the resident
 * who raised the ticket may close it, and so may staff holding
 * `serviceRequest.close`. The service owns that test — declaring the staff
 * permission here would lock the requester out of their own ticket.
 *
 * DELETE closes; it does not delete. The rating rides as a query param rather
 * than a body because it is the only field and a DELETE body is poorly
 * supported by intermediaries.
 */
export const DELETE = defineRoute({
  params: Params,
  query: z.object({
    satisfactionRating: z.coerce.number().int().min(1).max(5).optional(),
  }),
  idempotent: true,
  handler: async (ctx, { params, query }) => {
    const closerMembershipId = await meService.membershipId(ctx);

    const request = await serviceRequestService.close(
      ctx,
      params.id,
      closerMembershipId,
      query.satisfactionRating,
    );

    return {
      id: request._id.toHexString(),
      status: request.status,
      closedAt: request.closedAt,
      satisfactionRating: request.satisfactionRating ?? null,
    };
  },
});
