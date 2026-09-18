import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheAdapter } from './memory-adapter';
import { CacheNamespace, cacheKey } from './types';

describe('cacheKey', () => {
  it('namespaces keys so subsystems cannot collide', () => {
    expect(cacheKey(CacheNamespace.RATE_LIMIT, 'user', 'u1')).toBe('rl:user:u1');
    expect(cacheKey(CacheNamespace.GATE_CREDENTIAL, 'abc')).toBe('gate:abc');
  });
});

describe('MemoryCacheAdapter', () => {
  let cache: MemoryCacheAdapter;

  beforeEach(() => {
    cache = new MemoryCacheAdapter();
    vi.useRealTimers();
  });

  it('stores and retrieves structured values', async () => {
    await cache.set('k', { name: 'Ada', count: 2 });
    expect(await cache.get('k')).toEqual({ name: 'Ada', count: 2 });
  });

  it('returns null for a missing key', async () => {
    expect(await cache.get('nope')).toBeNull();
    expect(await cache.has('nope')).toBe(false);
  });

  it('deletes keys', async () => {
    await cache.set('k', 1);
    await cache.delete('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('deletes by prefix, leaving other namespaces intact', async () => {
    await cache.set('gate:a', 1);
    await cache.set('gate:b', 2);
    await cache.set('sess:c', 3);

    await cache.deleteByPrefix('gate:');

    expect(await cache.get('gate:a')).toBeNull();
    expect(await cache.get('gate:b')).toBeNull();
    expect(await cache.get('sess:c')).toBe(3);
  });

  describe('expiry', () => {
    it('expires values after the TTL', async () => {
      vi.useFakeTimers();
      await cache.set('k', 'v', 30);

      vi.advanceTimersByTime(29_000);
      expect(await cache.get('k')).toBe('v');

      vi.advanceTimersByTime(2_000);
      expect(await cache.get('k')).toBeNull();
    });

    it('keeps values without a TTL', async () => {
      vi.useFakeTimers();
      await cache.set('k', 'v');
      vi.advanceTimersByTime(10_000_000);
      expect(await cache.get('k')).toBe('v');
    });

    it('reports remaining TTL', async () => {
      vi.useFakeTimers();
      await cache.set('k', 'v', 60);
      vi.advanceTimersByTime(20_000);

      expect(await cache.ttl('k')).toBeLessThanOrEqual(40);
      expect(await cache.ttl('no-ttl-key')).toBeNull();
    });
  });

  describe('increment — the rate limiter primitive', () => {
    it('counts up from zero', async () => {
      expect(await cache.increment('c', 60)).toBe(1);
      expect(await cache.increment('c', 60)).toBe(2);
      expect(await cache.increment('c', 60)).toBe(3);
    });

    // A sliding window would let a steady stream of requests keep the counter
    // alive forever; the limit must reset a fixed interval after the first hit.
    it('uses a fixed window anchored to the first increment', async () => {
      vi.useFakeTimers();

      await cache.increment('c', 60);
      vi.advanceTimersByTime(30_000);
      expect(await cache.increment('c', 60)).toBe(2);

      // 61s after the FIRST increment, not the most recent one.
      vi.advanceTimersByTime(31_000);
      expect(await cache.increment('c', 60)).toBe(1);
    });

    it('counts concurrent increments exactly once each', async () => {
      const results = await Promise.all(Array.from({ length: 50 }, () => cache.increment('c', 60)));
      expect(new Set(results).size).toBe(50);
      expect(Math.max(...results)).toBe(50);
    });
  });

  it('clears everything on disconnect', async () => {
    await cache.set('k', 1);
    await cache.disconnect();
    expect(await cache.get('k')).toBeNull();
  });
});
