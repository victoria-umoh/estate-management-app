import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { serviceRequestService } from '@/modules/service-request';

/**
 * Only the two working states. `assigned`, `resolved` and `closed` each carry
 * their own data and their own rule, so they have their own routes.
 *
 * The permission is `serviceRequest.assign` rather than a weaker view-level
 * one, because that is what the service asserts: moving a ticket through its
 * working states is queue management.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.SERVICE_REQUEST_ASSIGN],
  params: z.object({ id: z.string() }),
  body: z.object({ status: z.enum(['in-progress', 'awaiting-resident']) }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const request = await serviceRequestService.setStatus(ctx, params.id, body.status);
    return { id: request._id.toHexString(), status: request.status };
  },
});
