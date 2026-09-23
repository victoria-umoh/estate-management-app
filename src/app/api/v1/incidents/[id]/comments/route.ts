import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { incidentService } from '@/modules/incident';
import { meService } from '@/modules/me';

const Params = z.object({ id: z.string() });

/**
 * Neither method declares a permission.
 *
 * The rule is not a permission: a resident may read and comment on the incident
 * they reported, and staff holding `incident.update` may do so on any. The
 * service owns that test, and it needs the caller's membership to apply it —
 * which is read from the session here, never from the request, or a resident
 * could pass the reporter's id and read someone else's case.
 */
export const GET = defineRoute({
  params: Params,
  handler: async (ctx, { params }) => {
    const viewerMembershipId = await meService.membershipId(ctx);
    // Internal notes are filtered inside the service, by the same permission
    // that decides whether the viewer is staff.
    const comments = await incidentService.comments(ctx, params.id, viewerMembershipId);

    return comments.map((comment) => ({
      id: comment._id.toHexString(),
      incidentId: comment.incidentId.toHexString(),
      authorMembershipId: comment.authorMembershipId.toHexString(),
      body: comment.body,
      internal: comment.internal,
      attachmentIds: comment.attachmentIds.map((attachmentId) => attachmentId.toHexString()),
      createdAt: comment.createdAt,
    }));
  },
});

export const POST = defineRoute({
  params: Params,
  body: z.object({
    body: z.string().trim().min(1).max(5000),
    // Honoured only for staff; the service downgrades it for anyone else, so a
    // resident cannot hide a comment from the people handling their case.
    internal: z.boolean().optional(),
    attachmentIds: z.array(z.string()).max(20).optional(),
  }),
  handler: async (ctx, { params, body }) => {
    const authorMembershipId = await meService.membershipId(ctx);

    const comment = await incidentService.comment(ctx, params.id, authorMembershipId, body.body, {
      ...(body.internal !== undefined ? { internal: body.internal } : {}),
      ...(body.attachmentIds ? { attachmentIds: body.attachmentIds } : {}),
    });

    return {
      id: comment._id.toHexString(),
      authorMembershipId: comment.authorMembershipId.toHexString(),
      body: comment.body,
      internal: comment.internal,
      createdAt: comment.createdAt,
    };
  },
});
