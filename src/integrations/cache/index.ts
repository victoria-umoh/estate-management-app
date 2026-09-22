import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { MemoryCacheAdapter } from './memory-adapter';
import type { CacheAdapter } from './types';

export { CacheNamespace, cacheKey, type CacheAdapter, type CacheNamespaceValue } from './types';
export { MemoryCacheAdapter } from './memory-adapter';

const log = createLogger('cache');

let instance: CacheAdapter | undefined;
let pending: Promise<CacheAdapter> | undefined;

/**
 * The configured cache.
 *
 * Redis and Upstash adapters are imported lazily so that a deployment using one
 * does not load the other's driver — and so tests never pull in a Redis client
 * at all.
 */
/**
 * The configured cache.
 *
 * Async because the external adapters are loaded with dynamic `import()`.
 * `require()` would be synchronous and simpler, but it is CommonJS: it works
 * under Next's bundler and throws under plain Node ESM, which meant every
 * script, job and worker crashed the moment it touched Redis.
 *
 * The promise is cached rather than the instance, so concurrent callers during
 * startup share one adapter instead of racing to construct several.
 */
export function getCache(): Promise<CacheAdapter> {
  pending ??= build();
  return pending;
}

async function build(): Promise<CacheAdapter> {
  if (instance) return instance;

  switch (config.cache.driver) {
    case 'ioredis': {
      const { RedisCacheAdapter } = await import('./redis-adapter');
      instance = new RedisCacheAdapter(config.cache.redisUrl!);
      break;
    }
    case 'upstash': {
      const { UpstashCacheAdapter } = await import('./upstash-adapter');
      instance = new UpstashCacheAdapter(config.cache.upstashUrl!, config.cache.upstashToken!);
      break;
    }
    default:
      instance = new MemoryCacheAdapter();
  }

  log.debug({ driver: config.cache.driver }, 'cache adapter initialised');
  return instance;
}

/** Test seam — replace the adapter and reset between suites. */
export function setCache(adapter: CacheAdapter | undefined): void {
  instance = adapter;
  pending = adapter ? Promise.resolve(adapter) : undefined;
}
