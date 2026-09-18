import { defineRoute } from '@/core/http';
import { authService, VerifyNinDto } from '@/modules/auth';

/**
 * Each attempt costs a paid provider lookup, so the limit is deliberately low —
 * it also stops the endpoint being used to test whether a NIN is registered.
 */
export const POST = defineRoute({
  status: 200,
  body: VerifyNinDto,
  rateLimit: { key: 'user', limit: 5, window: '1h', bucket: 'auth:nin' },
  handler: async (ctx, { body }) => authService.verifyNin(ctx.userId, body.nin),
});
