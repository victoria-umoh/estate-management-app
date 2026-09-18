import { defineRoute } from '@/core/http';
import { authService, ChangePasswordDto } from '@/modules/auth';

export const POST = defineRoute({
  status: 200,
  body: ChangePasswordDto,
  rateLimit: { key: 'user', limit: 5, window: '1h', bucket: 'auth:password' },
  handler: async (ctx, { body }) => {
    await authService.changePassword(ctx.userId, body.currentPassword, body.newPassword);
    // Every session including this one is revoked, so the client must sign in
    // again rather than silently continuing with a stale token.
    return { changed: true, sessionsRevoked: true };
  },
});
