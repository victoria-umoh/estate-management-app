import { defineRoute } from '@/core/http';
import { authService, LoginDto } from '@/modules/auth';

/**
 * Public. The per-IP limit blunts credential stuffing across many accounts;
 * per-account lockout in the service handles a targeted attack on one.
 */
export const POST = defineRoute({
  auth: false,
  status: 200,
  body: LoginDto,
  rateLimit: { key: 'ip', limit: 10, window: '5m', bucket: 'auth:login' },
  handler: async (_ctx, { body, request }) =>
    authService.login(body, {
      ...(clientIp(request) ? { ip: clientIp(request)! } : {}),
      ...(request.headers.get('user-agent')
        ? { userAgent: request.headers.get('user-agent')! }
        : {}),
    }),
});

function clientIp(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
}
