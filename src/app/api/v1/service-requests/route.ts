import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { serviceRequestService } from '@/modules/service-request';

const CATEGORIES = [
  'security',
  'water',
  'electricity',
  'waste',
  'roads',
  'drainage',
  'streetlight',
  'maintenance',
  'noise',
  'other',
] as const;

export const GET = defineRoute({
  permissions: [PERMISSIONS.SERVICE_REQUEST_VIEW],
  query: z.object({
    status: z
      .enum(['open', 'assigned', 'in-progress', 'awaiting-resident', 'resolved', 'closed'])
      .optional(),
    category: z.enum(CATEGORIES).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    overdue: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await serviceRequestService.list(ctx, filters, { page, limit });
    const now = Date.now();

    return paginated({
      ...result,
      items: result.items.map((request) => ({
        id: request._id.toHexString(),
        ticketNumber: request.ticketNumber,
        category: request.category,
        priority: request.priority,
        subject: request.subject,
        status: request.status,
        dueAt: request.dueAt,
        // Computed for display rather than stored, so it is never stale.
        overdue: request.dueAt.getTime() < now && !['resolved', 'closed'].includes(request.status),
        escalatedAt: request.escalatedAt,
        createdAt: request.createdAt,
      })),
    });
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.SERVICE_REQUEST_CREATE],
  body: z.object({
    requesterMembershipId: z.string().min(1),
    category: z.enum(CATEGORIES),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    subject: z.string().trim().min(4).max(160),
    description: z.string().trim().min(4).max(5000),
    location: z.string().trim().max(200).optional(),
    propertyId: z.string().optional(),
    attachmentIds: z.array(z.string()).max(20).optional(),
  }),
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'service-request:create' },
  handler: async (ctx, { body }) => {
    const { requesterMembershipId, ...input } = body;
    const request = await serviceRequestService.create(ctx, requesterMembershipId, input);

    return {
      id: request._id.toHexString(),
      ticketNumber: request.ticketNumber,
      dueAt: request.dueAt,
    };
  },
});
