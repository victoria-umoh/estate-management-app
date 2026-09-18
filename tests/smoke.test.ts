import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/utils';

describe('foundation smoke', () => {
  it('resolves conflicting tailwind utilities so the last one wins', () => {
    const isLarge = false;
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-sm', isLarge && 'text-lg')).toBe('text-sm');
  });

  it('loads hermetic test secrets rather than a developer .env', () => {
    expect(process.env.ENCRYPTION_KEY).toHaveLength(64);
    expect(process.env.JWT_ACCESS_SECRET).not.toBe(process.env.JWT_REFRESH_SECRET);
    expect(process.env.CACHE_DRIVER).toBe('memory');
  });
});
