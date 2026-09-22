import { config } from '@/core/config';

/**
 * Session cookies for the web client.
 *
 * The login endpoint returns tokens in its body so that a native mobile app can
 * hold them, but a browser must not: anything JavaScript can read, an injected
 * script can exfiltrate. So for web callers the same tokens are also set as
 * httpOnly cookies, and the browser client never sees or stores a token at all.
 *
 * `SameSite=Lax` rather than `Strict`: Strict would drop the session cookie on
 * any inbound link — including the one in a visitor-pass email — and log the
 * resident out for no security gain, since every mutating request is a POST
 * with a JSON content type, which a cross-site form cannot produce.
 */
export const ACCESS_COOKIE = 'eos_at';
export const REFRESH_COOKIE = 'eos_rt';

interface CookieOptions {
  name: string;
  value: string;
  maxAgeSeconds: number;
  /** Refresh tokens are only ever sent to the refresh and logout endpoints. */
  path?: string;
}

function serialise({ name, value, maxAgeSeconds, path = '/' }: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  // Secure is omitted on plain HTTP so local development works; production
  // config already refuses to start without HTTPS.
  if (config.app.url.startsWith('https://')) parts.push('Secure');

  return parts.join('; ');
}

export function sessionCookies(tokens: { accessToken: string; refreshToken: string }): string[] {
  return [
    serialise({
      name: ACCESS_COOKIE,
      value: tokens.accessToken,
      maxAgeSeconds: Math.floor(config.auth.accessTtlMs / 1000),
    }),
    serialise({
      name: REFRESH_COOKIE,
      value: tokens.refreshToken,
      maxAgeSeconds: Math.floor(config.auth.refreshTtlMs / 1000),
      // Scoped to the auth routes: a refresh token has no business being
      // attached to every API request it does not authenticate.
      path: '/api/v1/auth',
    }),
  ];
}

/** Expire both cookies. Used on logout and on a rejected refresh. */
export function clearedSessionCookies(): string[] {
  return [
    serialise({ name: ACCESS_COOKIE, value: '', maxAgeSeconds: 0 }),
    serialise({ name: REFRESH_COOKIE, value: '', maxAgeSeconds: 0, path: '/api/v1/auth' }),
  ];
}

/** Read one cookie from a request. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }

  return undefined;
}
