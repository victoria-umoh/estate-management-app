import { defineRoute } from '@/core/http';
import { authService, RegisterDto } from '@/modules/auth';

/**
 * Public. Rate limited per IP rather than per user, since there is no user yet,
 * and kept tight: registration writes to the database and runs argon2, so it is
 * an attractive target for resource exhaustion as well as for account spam.
 *
 * The response is identical whether or not the address is already registered.
 * It used to say "an account already exists with that email address", which
 * made this the one auth endpoint that confirmed an account — while
 * `/password/forgot` and `/verify-email/resend` go to some trouble not to. The
 * existing holder is emailed instead, so a person who has simply forgotten they
 * signed up still gets unstuck.
 */
export const POST = defineRoute({
  auth: false,
  body: RegisterDto,
  rateLimit: { key: 'ip', limit: 5, window: '15m', bucket: 'auth:register' },
  handler: async (_ctx, { body }) => {
    await authService.register(body);

    // No ids: returning them on success and not on a duplicate would restore
    // the oracle the uniform message exists to close.
    return { registered: true };
  },
});
