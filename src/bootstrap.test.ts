import { describe, expect, it, vi } from 'vitest';

/**
 * The wiring itself, which `define-route.test.ts` mocks out.
 *
 * Worth its own test because a silent failure here means every authenticated
 * route falls back to the fail-closed default and the whole API returns 401.
 */
describe('bootstrap', () => {
  it('registers the auth context resolver', async () => {
    const register = vi.fn();
    vi.doMock('@/modules/auth', () => ({ registerAuthContextResolver: register }));

    const { bootstrap } = await import('./bootstrap');
    bootstrap();

    expect(register).toHaveBeenCalledOnce();
  });

  it('is idempotent, since it runs from both instrumentation and the kernel', async () => {
    const register = vi.fn();
    vi.resetModules();
    vi.doMock('@/modules/auth', () => ({ registerAuthContextResolver: register }));

    const { bootstrap } = await import('./bootstrap');
    bootstrap();
    bootstrap();
    bootstrap();

    expect(register).toHaveBeenCalledOnce();
  });
});
