import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { notificationService } from '@/modules/notification';

/**
 * Mark one notification read.
 *
 * The service filters by recipient as well as id, so another resident's
 * notification is a 404 here — marking it read would hide it from the person it
 * was actually for.
 */
export const POST = defineRoute({
  params: z.object({ id: z.string() }),
  status: 200,
  handler: async (ctx, { params }) => {
    const notification = await notificationService.markRead(ctx, params.id);

    return {
      id: notification._id.toHexString(),
      read: true,
      readAt: notification.readAt ?? null,
    };
  },
});
