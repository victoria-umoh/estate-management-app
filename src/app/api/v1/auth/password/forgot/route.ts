import { defineRoute } from '@/core/http';
import { accountService, ForgotPasswordDto } from '@/modules/auth';

/**
 * Request a password reset link.
 *
 * ALWAYS `{ sent: true }`, 200, whether or not the address belongs to an
 * account. "No account with that email" is the single most useful sentence you
 * can give someone enumerating a customer list, and it buys the honest user
 * nothing they cannot learn from their own inbox thirty seconds later.
 *
 * The service holds the response to a fixed minimum duration, because the
 * timing difference between "look up nothing" and "write a token and queue an
 * email" is easily large enough to read over the network.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: ForgotPasswordDto,
  rateLimit: { key: 'ip', limit: 5, window: '15m', bucket: 'auth:password-forgot' },
  handler: async (_ctx, { body, request }) => {
    await accountService.requestPasswordReset(body.email, clientIp(request));

    // Deliberately says nothing conditional. Not "if that address is
    // registered" either — a hedge in the copy is still a hedge the attacker
    // never has to read, and the honest user reads it as doubt.
    return { sent: true };
  },
});

function clientIp(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
}
