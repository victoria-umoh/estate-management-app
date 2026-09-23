import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';
import { serviceRequestService } from '@/modules/service-request';

export const POST = defineRoute({
  permissions: [PERMISSIONS.SERVICE_REQUEST_RESOLVE],
  params: z.object({ id: z.string() }),
  body: z.object({ resolution: z.string().trim().min(4).max(5000) }),
  status: 200,
  // Resolution stamps the SLA outcome into the audit record. A retry must not
  // write that twice under a later timestamp.
  idempotent: true,
  handler: async (ctx, { params, body }) => {
    // From the session, never the body: who did the work is an attribution a
    // caller must not be able to hand to someone else.
    const resolverMembershipId = await meService.membershipId(ctx);

    const request = await serviceRequestService.resolve(
      ctx,
      params.id,
      resolverMembershipId,
      body.resolution,
    );

    return {
      id: request._id.toHexString(),
      status: request.status,
      resolution: request.resolution,
      resolvedAt: request.resolvedAt,
      resolvedByMembershipId: request.resolvedByMembershipId?.toHexString() ?? null,
    };
  },
});
