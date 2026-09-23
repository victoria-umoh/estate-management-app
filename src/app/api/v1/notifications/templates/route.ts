import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { notificationService } from '@/modules/notification';

/**
 * What the platform can say, and on which channels.
 *
 * Read-only, and there is deliberately no counterpart that writes: templates
 * live in code. See the note at the top of src/modules/notification/templates.ts
 * for why a runtime-editable template is a phishing kit with our sender
 * reputation attached.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.NOTIFICATION_TEMPLATE_MANAGE],
  handler: async (ctx) => notificationService.listTemplates(ctx),
});
