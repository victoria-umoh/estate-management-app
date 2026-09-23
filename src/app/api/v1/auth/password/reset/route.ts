import { defineRoute } from '@/core/http';
import { accountService, ResetPasswordDto } from '@/modules/auth';

/**
 * Redeem a reset link and set a new password.
 *
 * Every session for the account is revoked, including any the attacker who
 * prompted the reset is holding. The count comes back so the client can say so
 * plainly rather than leaving the user to wonder whether it worked.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: ResetPasswordDto,
  rateLimit: { key: 'ip', limit: 10, window: '15m', bucket: 'auth:password-reset' },
  handler: async (_ctx, { body }) => {
    const { sessionsRevoked } = await accountService.resetPassword(body.token, body.password);
    return { reset: true, sessionsRevoked };
  },
});
