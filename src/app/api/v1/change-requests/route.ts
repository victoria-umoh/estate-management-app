import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { changeRequestService } from '@/modules/change-request';

export const GET = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_APPROVE],
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const result = await changeRequestService.listPending(ctx, query);

    return paginated({
      ...result,
      items: result.items.map((request) => ({
        id: request._id.toHexString(),
        membershipId: request.membershipId.toHexString(),
        field: request.field,
        // Both values are masked; a reviewer judges the change, not the digits.
        currentValue: request.currentValueLabel,
        requestedValue: request.requestedValueLabel,
        reason: request.reason,
        requestedBy: request.requestedBy.toHexString(),
        createdAt: request.createdAt,
      })),
    });
  },
});

const SubmitDto = z.object({
  membershipId: z.string().min(1),
  field: z.enum(['nin', 'phone', 'email', 'propertyId', 'category', 'name']),
  value: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(1000).optional(),
  documentIds: z.array(z.string()).max(10).optional(),
});

export const POST = defineRoute({
  // Permission is decided in the service: a resident may propose changes to
  // their own record without holding resident.update.
  body: SubmitDto,
  rateLimit: { key: 'user', limit: 10, window: '1h', bucket: 'change-request:submit' },
  handler: async (ctx, { body }) => {
    const request = await changeRequestService.submit(ctx, body);
    return { id: request._id.toHexString(), status: request.status };
  },
});
