import { defineRoute } from '@/core/http';
import { authService, RegisterDto } from '@/modules/auth';

/**
 * Public. Rate limited per IP rather than per user, since there is no user yet,
 * and kept tight: registration writes to the database and runs argon2, so it is
 * an attractive target for resource exhaustion as well as for account spam.
 */
export const POST = defineRoute({
  auth: false,
  body: RegisterDto,
  rateLimit: { key: 'ip', limit: 5, window: '15m', bucket: 'auth:register' },
  handler: async (_ctx, { body }) => authService.register(body),
});
