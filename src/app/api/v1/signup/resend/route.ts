import { defineRoute } from '@/core/http';
import { SignupResendDto, signupService } from '@/modules/platform';

/**
 * Send the signup verification link again.
 *
 * Public, because the person asking has no session — that is the whole point of
 * the link they are asking for.
 *
 * The response is the same sentence whether or not the address has a pending
 * estate, so this cannot be used to test which addresses have signed up. The
 * service applies a per-address limit on top of this per-IP one: the IP limit
 * alone falls to a rotating source address, and the address limit alone falls
 * to someone walking a list of addresses once each.
 */
export const POST = defineRoute({
  auth: false,
  body: SignupResendDto,
  rateLimit: { key: 'ip', limit: 5, window: '15m', bucket: 'signup:resend' },
  status: 200,
  handler: async (ctx, { body }) =>
    signupService.resend(body.email, { ...(ctx.ip ? { ip: ctx.ip } : {}) }),
});
