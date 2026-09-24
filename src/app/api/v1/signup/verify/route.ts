import { defineRoute } from '@/core/http';
import { SignupVerifyDto, signupService } from '@/modules/platform';

/**
 * Redeem a signup link and open the estate.
 *
 * Public because the person holding the link has no session yet — proving
 * control of the inbox is precisely what this establishes. The token is the
 * credential: it is single-use, dies in an hour, and the service consumes it
 * with a conditional update so two clicks cannot both win.
 *
 * Rate limited per IP against brute-forcing token space. The tokens are opaque
 * random material, so the limit is a belt to the cryptographic braces rather
 * than the real defence.
 */
export const POST = defineRoute({
  auth: false,
  body: SignupVerifyDto,
  rateLimit: { key: 'ip', limit: 10, window: '15m', bucket: 'signup:verify' },
  status: 200,
  handler: async (_ctx, { body }) => signupService.verify(body.token),
});
