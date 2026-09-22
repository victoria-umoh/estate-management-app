import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defineRoute, sessionCookies } from '@/core/http';
import { authService, LoginDto } from '@/modules/auth';

/**
 * Sign in.
 *
 * Tokens are returned in the body for native clients, and also set as httpOnly
 * cookies for the browser. A web client never reads a token: anything
 * JavaScript can reach, an injected script can exfiltrate.
 *
 * The per-IP limit blunts credential stuffing across many accounts; per-account
 * lockout in the service handles a targeted attack on one.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: LoginDto.extend({
    /** Web clients get cookies; native clients rely on the body alone. */
    client: z.enum(['web', 'native']).optional(),
  }),
  rateLimit: { key: 'ip', limit: 10, window: '5m', bucket: 'auth:login' },
  handler: async (_ctx, { body, request }) => {
    const { client, ...credentials } = body;

    const result = await authService.login(credentials, {
      ...(clientIp(request) ? { ip: clientIp(request)! } : {}),
      ...(request.headers.get('user-agent')
        ? { userAgent: request.headers.get('user-agent')! }
        : {}),
    });

    // The kernel serialises the return value, so cookies are attached by
    // returning a response directly when the caller is a browser.
    if (client === 'web' && result.tokens) {
      const response = NextResponse.json({
        success: true as const,
        // Deliberately omits the tokens: a web client has no use for them and
        // every reason not to receive them.
        data: { user: result.user, authenticated: true },
      });

      for (const cookie of sessionCookies(result.tokens)) {
        response.headers.append('set-cookie', cookie);
      }

      return response;
    }

    return result;
  },
});

function clientIp(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
}
