import { defineRoute } from '@/core/http';
import { authService, RefreshDto } from '@/modules/auth';

/**
 * Public: the access token is expired by the time this is called, so the
 * refresh token is the only credential presented.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: RefreshDto,
  rateLimit: { key: 'ip', limit: 60, window: '5m', bucket: 'auth:refresh' },
  handler: async (_ctx, { body, request }) =>
    authService.refresh(body.refreshToken, {
      ...(request.headers.get('x-forwarded-for')
        ? { ip: request.headers.get('x-forwarded-for')!.split(',')[0]!.trim() }
        : {}),
    }),
});
