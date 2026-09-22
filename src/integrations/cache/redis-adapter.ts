import Redis from 'ioredis';
import { createLogger } from '@/core/logging';
import type { CacheAdapter } from './types';

const log = createLogger('cache:redis');

/** Redis-backed cache for self-hosted deployments. Also backs BullMQ. */
export class RedisCacheAdapter implements CacheAdapter {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      // Bounded retries and a short connect timeout are what stop a stalled
      // rate-limit check holding a request open indefinitely. They do that
      // without the offline queue disabled.
      maxRetriesPerRequest: 3,
      connectTimeout: 5_000,

      // The offline queue stays ENABLED. Disabling it rejects any command
      // issued before the TCP handshake completes — which in a short-lived
      // process (a seeder, a job, a worker) is every command, since the first
      // one is fired microseconds after construction. The queue buffers only
      // until the connection is up, and the retry limit still bounds failure.
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    this.client.on('error', (error) => log.error({ err: error }, 'redis error'));
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value written by another client, or a corrupted entry. Treat a cache
      // as advisory: drop it rather than failing the request.
      log.warn({ key }, 'discarding unparseable cache entry');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) await this.client.set(key, payload, 'EX', ttlSeconds);
    else await this.client.set(key, payload);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    // SCAN rather than KEYS: KEYS blocks the server for the whole sweep, which
    // on a shared instance would stall every other request.
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    // INCR then conditional EXPIRE, pipelined. The TTL is set only when the
    // counter is new, giving a fixed window rather than one that slides forward
    // with every request.
    const results = await this.client.multi().incr(key).ttl(key).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const currentTtl = Number(results?.[1]?.[1] ?? -1);

    if (currentTtl < 0) await this.client.expire(key, ttlSeconds);

    return count;
  }

  async ttl(key: string): Promise<number | null> {
    const seconds = await this.client.ttl(key);
    return seconds < 0 ? null : seconds;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
