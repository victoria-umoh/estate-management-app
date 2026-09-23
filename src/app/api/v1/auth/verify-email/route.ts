import { defineRoute } from '@/core/http';
import { accountService, VerifyEmailDto } from '@/modules/auth';

/**
 * Redeem an email-verification link.
 *
 * Public, because the whole point is that the holder cannot sign in yet. The
 * token is the credential; the per-IP limit exists to stop someone grinding
 * through the token space, which at 256 bits of entropy they will not manage
 * anyway, and to stop the endpoint being used as a database-write amplifier.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: VerifyEmailDto,
  rateLimit: { key: 'ip', limit: 10, window: '15m', bucket: 'auth:verify-email' },
  handler: async (_ctx, { body }) => {
    const { verified } = await accountService.verifyEmail(body.token);
    return { verified };
  },
});
