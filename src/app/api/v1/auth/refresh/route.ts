import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  REFRESH_COOKIE,
  clearedSessionCookies,
  defineRoute,
  readCookie,
  sessionCookies,
} from '@/core/http';
import { AuthenticationError } from '@/core/errors';
import { authService } from '@/modules/auth';

/**
 * Exchange a refresh token for a new pair.
 *
 * Public, because the access token is expired by the time this is called — the
 * refresh token is the only credential presented. A web client sends it as a
 * cookie and never handles it directly.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: z.object({ refreshToken: z.string().min(1).optional() }),
  rateLimit: { key: 'ip', limit: 60, window: '5m', bucket: 'auth:refresh' },
  handler: async (_ctx, { body, request }) => {
    const fromCookie = readCookie(request, REFRESH_COOKIE);
    const refreshToken = body.refreshToken ?? fromCookie;

    if (!refreshToken) {
      throw new AuthenticationError('No refresh token supplied.');
    }

    try {
      const tokens = await authService.refresh(refreshToken, {
        ...(request.headers.get('x-forwarded-for')
          ? { ip: request.headers.get('x-forwarded-for')!.split(',')[0]!.trim() }
          : {}),
      });

      // Cookie-based callers get rotated cookies and no token in the body.
      if (fromCookie && !body.refreshToken) {
        const response = NextResponse.json({
          success: true as const,
          data: { refreshed: true, expiresIn: tokens.expiresIn },
        });

        for (const cookie of sessionCookies(tokens)) {
          response.headers.append('set-cookie', cookie);
        }

        return response;
      }

      return tokens;
    } catch (error) {
      // A rejected refresh means the session is gone. Clearing the cookies
      // stops the browser retrying with a credential that will never work
      // again, which would otherwise look like a redirect loop.
      if (fromCookie) {
        const response = NextResponse.json(
          {
            success: false as const,
            error: { code: 'SESSION_REVOKED', message: 'Your session has ended. Please sign in.' },
          },
          { status: 401 },
        );

        for (const cookie of clearedSessionCookies()) {
          response.headers.append('set-cookie', cookie);
        }

        return response;
      }

      throw error;
    }
  },
});
