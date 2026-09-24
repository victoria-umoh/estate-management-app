import { defineRoute } from '@/core/http';
import { SignupDto, signupService } from '@/modules/platform';

/**
 * Self-serve estate signup.
 *
 * Unauthenticated, and it creates a TENANT — the most consequential public
 * endpoint in the product. Three defences apply here at the edge and the rest
 * are in the service:
 *
 *  - The IP limit is deliberately brutal. A signup provisions an estate, seeds
 *    twelve roles and runs argon2; three an hour from one address is far more
 *    than any real person needs and far less than an abuser wants. The service
 *    additionally limits by the blind index of the submitted address, which is
 *    the half that survives an attacker rotating IPs.
 *  - The body schema carries no slug, no plan and no role. Everything that
 *    decides what the new tenant IS comes from the server.
 *  - The response is one fixed sentence. It is the same whether an estate was
 *    created or the address was already registered, so this cannot be used to
 *    test whether somebody has an account.
 *
 * 202, not 201: nothing is usable yet. The estate exists but nobody can sign
 * into it until the emailed link is redeemed, and the status code should not
 * claim otherwise.
 */
export const POST = defineRoute({
  auth: false,
  body: SignupDto,
  rateLimit: { key: 'ip', limit: 3, window: '1h', bucket: 'signup' },
  status: 202,
  handler: async (ctx, { body }) =>
    signupService.start(body, ctx.ip ? { ip: ctx.ip } : {}),
});
