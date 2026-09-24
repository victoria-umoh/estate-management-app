import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { meService } from '@/modules/me';
import { serviceRequestService } from '@/modules/service-request';

const Params = z.object({ id: z.string() });

/**
 * Neither method declares a permission here.
 *
 * As with incident comments, the rule is not a permission: the resident who
 * raised the ticket may read and comment on it, and staff may do so on any. The
 * service owns that test and needs the caller's membership to apply it — which
 * is read from the session, never from the request, or a resident could pass
 * the requester's id and read another household's ticket.
 */
export const GET = defineRoute({
  params: Params,
  handler: async (ctx, { params }) => {
    const viewerMembershipId = await meService.membershipId(ctx);
    // Internal notes are filtered inside the service, by the same test that
    // decides whether the viewer is staff.
    const comments = await serviceRequestService.comments(ctx, params.id, viewerMembershipId);

    return comments.map((comment) => ({
      id: comment._id.toHexString(),
      serviceRequestId: comment.serviceRequestId.toHexString(),
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
    // resident cannot hide a comment from the people fixing their problem.
    internal: z.boolean().optional(),
    attachmentIds: z.array(z.string()).max(20).optional(),
  }),
  handler: async (ctx, { params, body }) => {
    const authorMembershipId = await meService.membershipId(ctx);

    const comment = await serviceRequestService.comment(
      ctx,
      params.id,
      authorMembershipId,
      body.body,
      {
        ...(body.internal !== undefined ? { internal: body.internal } : {}),
        ...(body.attachmentIds ? { attachmentIds: body.attachmentIds } : {}),
      },
    );

    return {
      id: comment._id.toHexString(),
      authorMembershipId: comment.authorMembershipId.toHexString(),
      body: comment.body,
      internal: comment.internal,
      createdAt: comment.createdAt,
    };
  },
});
