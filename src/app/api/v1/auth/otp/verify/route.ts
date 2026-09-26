import { defineRoute } from '@/core/http';
import { accountService, VerifyOtpDto } from '@/modules/auth';

export const POST = defineRoute({
  status: 200,
  body: VerifyOtpDto,
  rateLimit: { key: 'user', limit: 10, window: '15m', bucket: 'auth:otp-verify' },
  handler: async (ctx, { body }) => {
    await accountService.confirmPhoneVerification(ctx, body.phone, body.code);
    return { verified: true };
  },
});
