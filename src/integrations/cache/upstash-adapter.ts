import { Redis } from '@upstash/redis';
import { createLogger } from '@/core/logging';
import type { CacheAdapter } from './types';

const log = createLogger('cache:upstash');

/**
 * Upstash REST-backed cache for serverless deployments, where holding a TCP
 * Redis connection per invocation is not viable.
 */
export class UpstashCacheAdapter implements CacheAdapter {
  private readonly client: Redis;

  constructor(url: string, token: string) {
    this.client = new Redis({ url, token });
  }

  async get<T>(key: string): Promise<T | null> {
    // The Upstash client deserialises JSON for us.
    return ((await this.client.get<T>(key)) ?? null) as T | null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, { ex: ttlSeconds });
    else await this.client.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(Number(cursor), {
        match: `${prefix}*`,
        count: 200,
      });
      cursor = String(next);
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    // Set the expiry only on the first increment, so the window is fixed rather
    // than sliding forward with each request.
    if (count === 1) await this.client.expire(key, ttlSeconds);
    return count;
  }

  async ttl(key: string): Promise<number | null> {
    const seconds = await this.client.ttl(key);
    return seconds < 0 ? null : seconds;
  }

  async disconnect(): Promise<void> {
    // REST client — nothing to close.
    log.debug('upstash adapter disconnect is a no-op');
  }
}
