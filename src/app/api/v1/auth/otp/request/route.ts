import { defineRoute } from '@/core/http';
import { issueOtp, RequestOtpDto } from '@/modules/auth';
import { createLogger } from '@/core/logging';
import { config } from '@/core/config';

const log = createLogger('auth:otp');

/**
 * Sending an SMS costs money and reaches a real handset, so this is one of the
 * tightest limits in the system — an unthrottled endpoint here is both a bill
 * and a way to harass a phone number.
 */
export const POST = defineRoute({
  status: 200,
  body: RequestOtpDto,
  rateLimit: { key: 'user', limit: 3, window: '15m', bucket: 'auth:otp-request' },
  handler: async (_ctx, { body }) => {
    const code = await issueOtp('phone-verification', body.phone);

    // Phase 10 replaces this with the SMS provider. Until then the code is
    // logged in development only, and never in production.
    if (!config.isProduction) log.debug({ phone: body.phone, code }, 'OTP issued (dev only)');

    return { sent: true, expiresInSeconds: Math.floor(config.auth.otp.ttlMs / 1000) };
  },
});
