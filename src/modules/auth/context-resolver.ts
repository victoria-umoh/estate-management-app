import { setContextResolver } from '@/core/http';
import { enrichLogContext, getCorrelationId } from '@/core/logging';
import type { RequestContext } from '@/core/tenancy';
import { verifyAccessToken } from './tokens';

/**
 * Turn a request's bearer token into a RequestContext.
 *
 * Registered with the HTTP kernel at startup. Until this runs, every
 * authenticated route fails closed — see `core/http/auth-provider.ts`.
 *
 * Deliberately does NOT hit the database. The access token already carries the
 * user, estate, roles and permissions, and it is short-lived precisely so it
 * can be trusted without a lookup. Adding a read here would put a database
 * round trip on the gate path, which is the one thing the design will not
 * spend.
 *
 * The cost of that choice is bounded: revoking a role or suspending a resident
 * takes effect at the next token refresh rather than instantly. Where that is
 * not acceptable — a blacklisted vehicle, a revoked pass — the gate checks the
 * credential store directly, which is authoritative and cached separately.
 */
export function registerAuthContextResolver(): void {
  setContextResolver(async (request) => {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;

    const token = header.slice('Bearer '.length).trim();
    if (!token) return null;

    // Throws AuthenticationError on an expired or forged token, which the
    // kernel maps to 401 with a code the client can branch on.
    const claims = await verifyAccessToken(token);

    const context: RequestContext = {
      userId: claims.sub,
      estateId: claims.est,
      roles: claims.roles ?? [],
      permissions: new Set(claims.perms ?? []),
      correlationId: getCorrelationId() ?? 'unknown',
      sessionId: claims.sid,
      isPlatformAdmin: claims.adm === true,
      ...(clientIp(request) ? { ip: clientIp(request) } : {}),
      ...(request.headers.get('user-agent')
        ? { userAgent: request.headers.get('user-agent')! }
        : {}),
    };

    // Attribute the log lines emitted after this point, including the ones from
    // before authentication resolved.
    enrichLogContext({ userId: context.userId, estateId: context.estateId });

    return context;
  });
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return request.headers.get('x-real-ip') ?? undefined;
}
