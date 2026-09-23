import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { announcementService } from '@/modules/announcement';
import { serializeAnnouncement } from '../../route';

/**
 * Publish, and fan out to the targeted audience.
 *
 * Idempotent, because this is the one action here that puts a message in front
 * of every resident on the estate — a double-tapped button must not send it
 * twice. Publishing an already-published announcement is a no-op in the service
 * as well, so the guarantee does not depend on the client sending a key.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.ANNOUNCEMENT_PUBLISH, PERMISSIONS.NOTIFICATION_SEND],
  params: z.object({ id: z.string() }),
  idempotent: true,
  status: 200,
  handler: async (ctx, { params }) =>
    serializeAnnouncement(await announcementService.publish(ctx, params.id)),
});
