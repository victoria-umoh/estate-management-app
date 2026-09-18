import type { CacheAdapter } from './types';

interface Entry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * In-process cache for development and tests.
 *
 * NOT valid in production — state is per-process, so rate limit counters would
 * not be shared between instances. The config schema enforces that.
 */
export class MemoryCacheAdapter implements CacheAdapter {
  private readonly store = new Map<string, Entry>();

  private read(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // Expire lazily on read; there is no background sweeper, which is fine for
    // a process-lifetime cache.
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.read(key)?.value as T) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  async has(key: string): Promise<boolean> {
    return this.read(key) !== undefined;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const existing = this.read(key);
    const next = ((existing?.value as number) ?? 0) + 1;

    this.store.set(key, {
      value: next,
      // Preserve the original expiry so the window is fixed from first request,
      // rather than sliding forward with every increment — otherwise a steady
      // stream of requests would keep the window alive indefinitely.
      expiresAt: existing?.expiresAt ?? Date.now() + ttlSeconds * 1000,
    });

    return next;
  }

  async ttl(key: string): Promise<number | null> {
    const entry = this.read(key);
    if (!entry?.expiresAt) return null;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async disconnect(): Promise<void> {
    this.store.clear();
  }

  /** Test helper. */
  clear(): void {
    this.store.clear();
  }
}
