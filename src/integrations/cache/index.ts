import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { MemoryCacheAdapter } from './memory-adapter';
import type * as RedisAdapterModule from './redis-adapter';
import type * as UpstashAdapterModule from './upstash-adapter';
import type { CacheAdapter } from './types';

export { CacheNamespace, cacheKey, type CacheAdapter, type CacheNamespaceValue } from './types';
export { MemoryCacheAdapter } from './memory-adapter';

const log = createLogger('cache');

let instance: CacheAdapter | undefined;

/**
 * The configured cache.
 *
 * Redis and Upstash adapters are imported lazily so that a deployment using one
 * does not load the other's driver — and so tests never pull in a Redis client
 * at all.
 */
export function getCache(): CacheAdapter {
  if (instance) return instance;

  switch (config.cache.driver) {
    case 'ioredis': {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { RedisCacheAdapter } = require('./redis-adapter') as typeof RedisAdapterModule;
      instance = new RedisCacheAdapter(config.cache.redisUrl!);
      break;
    }
    case 'upstash': {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { UpstashCacheAdapter } = require('./upstash-adapter') as typeof UpstashAdapterModule;
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
}
