import { RateLimitError } from '@/core/errors';
import { CacheNamespace, cacheKey, getCache } from '@/integrations/cache';

/**
 * Fixed-window rate limiting backed by the shared cache.
 *
 * Fixed windows can allow a burst across a boundary (up to 2x the limit in a
 * narrow span). That is an accepted trade: the alternative sliding-window
 * implementations cost extra round trips on every request, and the gate path
 * cannot afford them. Where burst tolerance actually matters — login, OTP — the
 * limits are set low enough that 2x is still safe.
 */

export type RateLimitScope = 'user' | 'ip' | 'global';

export interface RateLimitRule {
  /** What to count against. */
  key: RateLimitScope;
  limit: number;
  /** Window length, e.g. '1m', '15m'. */
  window: string;
  /** Distinguishes counters for different routes sharing a scope. */
  bucket?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const WINDOW_PATTERN = /^(\d+)(s|m|h)$/;

function windowToSeconds(window: string): number {
  const match = WINDOW_PATTERN.exec(window);
  if (!match) throw new Error(`Invalid rate limit window "${window}". Use 30s, 1m or 1h.`);

  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h';
  return amount * (unit === 's' ? 1 : unit === 'm' ? 60 : 3600);
}

/**
 * Consume one unit against a rule.
 *
 * Returns the outcome rather than throwing, so callers can attach the standard
 * `X-RateLimit-*` headers to successful responses too — clients that can see
 * how much budget remains are far less likely to hit the wall.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  identity: { userId?: string; ip?: string; route: string },
): Promise<RateLimitResult> {
  const windowSeconds = windowToSeconds(rule.window);

  const subject =
    rule.key === 'user'
      ? (identity.userId ?? identity.ip ?? 'anonymous')
      : rule.key === 'ip'
        ? (identity.ip ?? 'unknown')
        : 'global';

  const key = cacheKey(CacheNamespace.RATE_LIMIT, rule.bucket ?? identity.route, rule.key, subject);

  const count = await getCache().increment(key, windowSeconds);
  const ttl = (await getCache().ttl(key)) ?? windowSeconds;

  return {
    allowed: count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: ttl,
  };
}

/** Consume and throw a 429 when exhausted. */
export async function enforceRateLimit(
  rule: RateLimitRule,
  identity: { userId?: string; ip?: string; route: string },
): Promise<RateLimitResult> {
  const result = await consumeRateLimit(rule, identity);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.retryAfterSeconds),
  };
}
