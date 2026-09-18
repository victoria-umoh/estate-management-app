import { defineRoute } from '@/core/http';
import { verifyOtp, VerifyOtpDto } from '@/modules/auth';

export const POST = defineRoute({
  status: 200,
  body: VerifyOtpDto,
  rateLimit: { key: 'user', limit: 10, window: '15m', bucket: 'auth:otp-verify' },
  handler: async (_ctx, { body }) => {
    await verifyOtp('phone-verification', body.phone, body.code);
    return { verified: true };
  },
});
