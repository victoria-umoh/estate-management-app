import { defineRoute } from '@/core/http';
import { accountService, ResendVerificationDto } from '@/modules/auth';

/**
 * Ask for another verification link.
 *
 * Answers `{ sent: true }` for every well-formed address — registered or not,
 * already verified or not. The service pads the response to a fixed floor for
 * the same reason, because a response that is only ever fast for strangers is
 * an enumeration oracle that no amount of identical JSON will hide.
 *
 * Limited per IP here and per submitted address in the service: the first stops
 * one host hammering many addresses, the second stops many hosts hammering one.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: ResendVerificationDto,
  rateLimit: { key: 'ip', limit: 5, window: '15m', bucket: 'auth:verify-email-resend' },
  handler: async (_ctx, { body, request }) => {
    await accountService.resendEmailVerification(body.email, clientIp(request));
    return { sent: true };
  },
});

function clientIp(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
}
