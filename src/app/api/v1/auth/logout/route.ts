import { NextResponse } from 'next/server';
import { z } from 'zod';
import { REFRESH_COOKIE, clearedSessionCookies, defineRoute, readCookie } from '@/core/http';
import { authService } from '@/modules/auth';

export const POST = defineRoute({
  auth: false,
  status: 200,
  body: z.object({ refreshToken: z.string().optional() }),
  handler: async (_ctx, { body, request }) => {
    const refreshToken = body.refreshToken ?? readCookie(request, REFRESH_COOKIE);

    // Silent when absent: reporting an error would confirm whether a token was
    // valid, and logging out is not an operation worth failing.
    if (refreshToken) await authService.logout(refreshToken);

    const response = NextResponse.json({ success: true as const, data: { loggedOut: true } });
    for (const cookie of clearedSessionCookies()) {
      response.headers.append('set-cookie', cookie);
    }

    return response;
  },
});
