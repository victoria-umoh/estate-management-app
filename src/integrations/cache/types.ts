/**
 * Cache abstraction.
 *
 * Deployments differ — in-process for tests, Redis when self-hosted, Upstash
 * HTTP on serverless — but the calling code does not. Rate limiting in
 * particular MUST be backed by a shared store in production: a per-process
 * counter gives an attacker N times the intended attempts across N instances,
 * which is why the config schema rejects `memory` there.
 */
export interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete every key carrying a prefix. Used to invalidate a credential group. */
  deleteByPrefix(prefix: string): Promise<void>;
  has(key: string): Promise<boolean>;

  /**
   * Atomically increment a counter and return the new value, setting the TTL on
   * first write. Atomicity is what makes this usable as a rate limiter: a
   * read-then-write would let concurrent requests both observe the old count.
   */
  increment(key: string, ttlSeconds: number): Promise<number>;

  /** Seconds remaining on a key's TTL; null when absent or non-expiring. */
  ttl(key: string): Promise<number | null>;

  /** Release connections. Called on shutdown and between test suites. */
  disconnect(): Promise<void>;
}

/** Namespacing keeps subsystems from colliding in a shared Redis instance. */
export const CacheNamespace = {
  RATE_LIMIT: 'rl',
  GATE_CREDENTIAL: 'gate',
  SESSION: 'sess',
  OTP: 'otp',
  IDEMPOTENCY: 'idem',
  ENTITLEMENTS: 'ent',
  LOCK: 'lock',
} as const;

export type CacheNamespaceValue = (typeof CacheNamespace)[keyof typeof CacheNamespace];

export function cacheKey(namespace: CacheNamespaceValue, ...parts: string[]): string {
  return `${namespace}:${parts.join(':')}`;
}
