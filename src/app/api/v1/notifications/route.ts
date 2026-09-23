import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { notificationService } from '@/modules/notification';

/**
 * The caller's own notifications.
 *
 * No membership id is accepted from the request: the service resolves it from
 * the session through meService. A route that took one would let anyone read
 * another household's alerts by changing a single value in dev tools.
 */
export const GET = defineRoute({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
    unreadOnly: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  }),
  handler: async (ctx, { query }) => {
    const result = await notificationService.listForCaller(ctx, query);

    return paginated({
      ...result,
      items: result.items.map((notification) => ({
        id: notification._id.toHexString(),
        templateId: notification.templateId,
        category: notification.category,
        priority: notification.priority,
        title: notification.title,
        body: notification.body,
        actionUrl: notification.actionUrl ?? null,
        resourceType: notification.resourceType ?? null,
        resourceId: notification.resourceId ?? null,
        read: notification.readAt !== null && notification.readAt !== undefined,
        readAt: notification.readAt ?? null,
        createdAt: notification.createdAt,
      })),
    });
  },
});
