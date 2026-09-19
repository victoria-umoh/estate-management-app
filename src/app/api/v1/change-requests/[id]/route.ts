import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { changeRequestService } from '@/modules/change-request';

const ReviewDto = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Review a request.
 *
 * The service refuses when the reviewer is the submitter, so a member of staff
 * holding both update and approve cannot change their own details unobserved.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_APPROVE],
  params: z.object({ id: z.string() }),
  body: ReviewDto,
  status: 200,
  handler: async (ctx, { params, body }) => {
    const request = await changeRequestService.review(ctx, params.id, body);
    return { id: request._id.toHexString(), status: request.status };
  },
});

export const DELETE = defineRoute({
  params: z.object({ id: z.string() }),
  status: 200,
  handler: async (ctx, { params }) => {
    await changeRequestService.withdraw(ctx, params.id);
    return { withdrawn: true };
  },
});
