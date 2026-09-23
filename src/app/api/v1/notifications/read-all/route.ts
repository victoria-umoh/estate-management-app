import { defineRoute } from '@/core/http';
import { notificationService } from '@/modules/notification';

/** Clear the caller's unread badge in one call. */
export const POST = defineRoute({
  status: 200,
  handler: async (ctx) => ({ marked: await notificationService.markAllRead(ctx) }),
});
