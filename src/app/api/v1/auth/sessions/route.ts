import { defineRoute } from '@/core/http';
import { authService, sessionRepository } from '@/modules/auth';

/**
 * The caller's own active sessions, so a resident can spot a device they do not
 * recognise. Scoped to the authenticated user — there is no parameter for
 * whose sessions to list.
 */
export const GET = defineRoute({
  handler: async (ctx) => {
    const sessions = await sessionRepository.listActiveForUser(ctx.userId);

    return sessions.map((session) => ({
      id: session._id.toHexString(),
      deviceName: session.device.name,
      // The IP is shown to help the user recognise a session; the user agent is
      // not, because it is long, uninformative and fingerprint-ish.
      ip: session.device.ip,
      lastUsedAt: session.lastUsedAt,
      createdAt: session.createdAt,
      current: session._id.toHexString() === ctx.sessionId,
    }));
  },
});

export const DELETE = defineRoute({
  status: 200,
  handler: async (ctx) => {
    // Keeps the current session alive, so signing out other devices does not
    // sign you out of the one you are using.
    const revoked = await authService.logoutAll(ctx.userId, ctx.sessionId);
    return { revoked };
  },
});
