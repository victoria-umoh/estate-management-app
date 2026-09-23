import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { NOTIFICATION_CATEGORIES, notificationService } from '@/modules/notification';

const ChannelToggles = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
});

/**
 * In-app is absent on purpose: it is the durable record, not a channel, and a
 * resident who silenced it would have no way to discover anything at all.
 *
 * Emergency and security are accepted here and ignored by the service. The
 * client may be an old build that still renders the toggle, and rejecting the
 * whole request would discard the legitimate changes alongside it — the
 * response says what was actually stored.
 */
const Body = z.object(
  Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, ChannelToggles.optional()])),
);

export const GET = defineRoute({
  handler: async (ctx) => notificationService.preferencesForCaller(ctx),
});

export const PATCH = defineRoute({
  body: Body,
  status: 200,
  handler: async (ctx, { body }) => notificationService.updatePreferencesForCaller(ctx, body),
});
