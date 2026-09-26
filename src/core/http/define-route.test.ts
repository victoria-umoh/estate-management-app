import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import { AuthenticationError, InternalError, NotFoundError } from '@/core/errors';
import type { RequestContext } from '@/core/tenancy';
import { setContextResolver } from './auth-provider';
import { defineRoute } from './define-route';

// The kernel opens a database connection; these tests exercise HTTP behaviour
// only, so that is stubbed out.
vi.mock('@/core/db', () => ({ connectToDatabase: vi.fn().mockResolvedValue(undefined) }));

// The kernel self-bootstraps runtime wiring on its first request, which would
// install the real auth resolver and override the stub each test installs.
// These tests cover the kernel, not the wiring; `bootstrap.test.ts` covers that.
vi.mock('@/bootstrap', () => ({ bootstrap: vi.fn() }));

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user-1',
    estateId: 'estate-1',
    roles: ['resident'],
    permissions: new Set(['visitor.create']),
    correlationId: 'test',
    isPlatformAdmin: false,
    ...overrides,
  };
}

function request(
  url = 'http://localhost/api/v1/things',
  init: RequestInit & { method?: string } = {},
): Request {
  return new Request(url, { method: 'GET', ...init });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

let cache: MemoryCacheAdapter;

beforeEach(() => {
  cache = new MemoryCacheAdapter();
  setCache(cache);
  setContextResolver(async () => makeContext());
});

afterEach(() => {
  setCache(undefined);
  vi.restoreAllMocks();
});

describe('authentication', () => {
  it('rejects an unauthenticated request to a protected route', async () => {
    setContextResolver(async () => null);
    const route = defineRoute({ handler: async () => ({ ok: true }) });

    const response = await route(request());
    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe('UNAUTHENTICATED');
  });

  it('allows an unauthenticated request to a public route', async () => {
    setContextResolver(async () => null);
    const route = defineRoute({ auth: false, handler: async () => ({ ok: true }) });

    expect((await route(request())).status).toBe(200);
  });

  // If the auth module were never registered, routes must fail closed rather
  // than run with an empty context.
  it('fails closed when no resolver is registered', async () => {
    setContextResolver(async () => {
      throw new AuthenticationError('Authentication is not configured on this server.');
    });

    expect((await defineRoute({ handler: async () => ({}) })(request())).status).toBe(401);
  });

  // A stale session cookie must not block the login meant to replace it.
  it('treats an invalid token on a public route as anonymous', async () => {
    setContextResolver(async () => {
      throw new AuthenticationError('Invalid authentication token.');
    });
    let seen: RequestContext | undefined;

    const response = await defineRoute({
      auth: false,
      handler: async (ctx) => {
        seen = ctx;
        return {};
      },
    })(request());

    expect(response.status).toBe(200);
    expect(seen?.userId).toBe('anonymous');
  });

  it('still rejects an invalid token on a protected route', async () => {
    setContextResolver(async () => {
      throw new AuthenticationError('Invalid authentication token.');
    });

    expect((await defineRoute({ handler: async () => ({}) })(request())).status).toBe(401);
  });

  it('does not swallow non-authentication failures on a public route', async () => {
    setContextResolver(async () => {
      throw new InternalError('resolver crashed');
    });

    expect((await defineRoute({ auth: false, handler: async () => ({}) })(request())).status).toBe(
      500,
    );
  });

  it('gives public routes an anonymous context with no estate or permissions', async () => {
    setContextResolver(async () => null);
    let seen: RequestContext | undefined;

    await defineRoute({
      auth: false,
      handler: async (ctx) => {
        seen = ctx;
        return {};
      },
    })(request());

    expect(seen?.userId).toBe('anonymous');
    expect(seen?.estateId).toBe('');
    expect(seen?.permissions.size).toBe(0);
  });
});

describe('authorisation', () => {
  it('allows a caller holding the permission', async () => {
    const route = defineRoute({
      permissions: ['visitor.create'],
      handler: async () => ({ ok: true }),
    });
    expect((await route(request())).status).toBe(200);
  });

  it('denies a caller missing the permission', async () => {
    const route = defineRoute({
      permissions: ['payment.refund'],
      handler: async () => ({ ok: true }),
    });

    const response = await route(request());
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe('FORBIDDEN');
  });

  it('requires every listed permission', async () => {
    const route = defineRoute({
      permissions: ['visitor.create', 'visitor.approve'],
      handler: async () => ({ ok: true }),
    });
    expect((await route(request())).status).toBe(403);
  });

  it('honours the wildcard permission', async () => {
    setContextResolver(async () => makeContext({ permissions: new Set(['*']) }));
    const route = defineRoute({ permissions: ['anything.at.all'], handler: async () => ({}) });
    expect((await route(request())).status).toBe(200);
  });

  // The handler must never run when authorisation fails.
  it('does not invoke the handler on denial', async () => {
    const handler = vi.fn();
    await defineRoute({ permissions: ['nope'], handler })(request());
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  const bodySchema = z.object({ name: z.string().min(2), age: z.number().int().positive() });

  const route = defineRoute({
    body: bodySchema,
    handler: async (_ctx, { body }) => body,
  });

  function post(body: unknown) {
    return request('http://localhost/api/v1/things', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  it('accepts a valid body', async () => {
    const response = await route(post({ name: 'Ada', age: 30 }));
    expect(response.status).toBe(201);
    expect((await json(response)).data).toEqual({ name: 'Ada', age: 30 });
  });

  it('rejects an invalid body with field-level detail', async () => {
    const response = await route(post({ name: 'A', age: -1 }));
    const payload = await json(response);

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('VALIDATION_FAILED');
    expect(payload.error.details.map((d: any) => d.field)).toEqual(['body.name', 'body.age']);
  });

  it('rejects malformed JSON', async () => {
    const response = await route(
      request('http://localhost/api/v1/things', { method: 'POST', body: '{not json' }),
    );
    expect(response.status).toBe(400);
  });

  it('strips unknown fields rather than trusting them', async () => {
    const response = await route(post({ name: 'Ada', age: 30, isAdmin: true }));
    expect((await json(response)).data).not.toHaveProperty('isAdmin');
  });

  it('validates and coerces query parameters', async () => {
    const queryRoute = defineRoute({
      query: z.object({ page: z.coerce.number().int().positive().default(1) }),
      handler: async (_ctx, { query }) => query,
    });

    expect(
      (await json(await queryRoute(request('http://localhost/api/v1/x?page=3')))).data,
    ).toEqual({
      page: 3,
    });
    expect((await queryRoute(request('http://localhost/api/v1/x?page=abc'))).status).toBe(400);
  });
});

describe('rate limiting', () => {
  const route = defineRoute({
    rateLimit: { key: 'user', limit: 3, window: '1m', bucket: 'test' },
    handler: async () => ({ ok: true }),
  });

  it('allows requests up to the limit then returns 429', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await route(request())).status).toBe(200);
    }

    const blocked = await route(request());
    expect(blocked.status).toBe(429);
    expect((await json(blocked)).error.code).toBe('RATE_LIMITED');
  });

  it('advertises remaining budget on successful responses', async () => {
    const response = await route(request());
    expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('2');
  });

  it('sets Retry-After when blocked', async () => {
    for (let i = 0; i < 4; i++) await route(request());
    expect((await route(request())).headers.get('Retry-After')).toBeTruthy();
  });

  it('counts each user separately', async () => {
    for (let i = 0; i < 3; i++) await route(request());

    setContextResolver(async () => makeContext({ userId: 'user-2' }));
    expect((await route(request())).status).toBe(200);
  });
});

describe('idempotency', () => {
  let calls = 0;

  const route = defineRoute({
    idempotent: true,
    body: z.object({ amount: z.number() }),
    handler: async (_ctx, { body }) => {
      calls += 1;
      return { charged: body.amount, call: calls };
    },
  });

  function pay(amount: number, key: string) {
    return request('http://localhost/api/v1/payments', {
      method: 'POST',
      body: JSON.stringify({ amount }),
      headers: { 'idempotency-key': key },
    });
  }

  beforeEach(() => {
    calls = 0;
  });

  // The motivating case: a resident double-taps Pay, or a mobile client retries
  // after a timeout it could not distinguish from a failure.
  it('executes once and replays the stored response', async () => {
    const first = await route(pay(5000, 'key-1'));
    const second = await route(pay(5000, 'key-1'));

    expect(calls).toBe(1);
    expect((await json(first)).data).toEqual((await json(second)).data);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');
  });

  it('marks the first response as fresh', async () => {
    expect((await route(pay(5000, 'key-2'))).headers.get('Idempotent-Replay')).toBeNull();
  });

  // Replaying the first response for different data would silently discard the
  // second request.
  it('rejects key reuse with a different body', async () => {
    await route(pay(5000, 'key-3'));
    const response = await route(pay(9999, 'key-3'));

    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('treats different keys as different requests', async () => {
    await route(pay(5000, 'key-4'));
    await route(pay(5000, 'key-5'));
    expect(calls).toBe(2);
  });

  it('runs normally when no key is supplied', async () => {
    await route(
      request('http://localhost/api/v1/payments', {
        method: 'POST',
        body: JSON.stringify({ amount: 100 }),
      }),
    );
    expect(calls).toBe(1);
  });

  // A transient failure must not lock the client out for the whole window.
  it('releases the key after a failure so the client can retry', async () => {
    let attempt = 0;
    const flaky = defineRoute({
      idempotent: true,
      body: z.object({ amount: z.number() }),
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw new InternalError('transient database error');
        return { ok: true };
      },
    });

    expect((await flaky(pay(100, 'retry-key'))).status).toBe(500);
    expect((await flaky(pay(100, 'retry-key'))).status).toBe(201);
  });
});

describe('error handling', () => {
  it('maps a domain error to its status code', async () => {
    const route = defineRoute({
      handler: async () => {
        throw new NotFoundError('Resident');
      },
    });

    const response = await route(request());
    expect(response.status).toBe(404);
    expect((await json(response)).error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resident not found.',
    });
  });

  it('wraps an unexpected throw as a 500', async () => {
    const route = defineRoute({
      handler: async () => {
        throw new Error('mongodb://admin:hunter2@10.0.0.5');
      },
    });

    const response = await route(request());
    expect(response.status).toBe(500);
    expect((await json(response)).error.code).toBe('INTERNAL_ERROR');
  });

  it('returns a correlation id on success and on failure', async () => {
    const okRoute = defineRoute({ handler: async () => ({}) });
    expect((await okRoute(request())).headers.get('x-correlation-id')).toBeTruthy();

    const errRoute = defineRoute({
      handler: async () => {
        throw new NotFoundError();
      },
    });
    const response = await errRoute(request());
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
    expect((await json(response)).error.requestId).toBeTruthy();
  });

  it('reuses an upstream correlation id so traces span the call chain', async () => {
    const route = defineRoute({ handler: async () => ({}) });
    const response = await route(
      request('http://localhost/api/v1/x', { headers: { 'x-correlation-id': 'trace-abc' } }),
    );
    expect(response.headers.get('x-correlation-id')).toBe('trace-abc');
  });
});

describe('response envelope', () => {
  it('wraps success payloads consistently', async () => {
    const route = defineRoute({ handler: async () => ({ id: '1' }) });
    expect(await json(await route(request()))).toEqual({ success: true, data: { id: '1' } });
  });

  it('defaults POST to 201 and GET to 200', async () => {
    const route = defineRoute({ handler: async () => ({}) });
    expect((await route(request('http://localhost/x', { method: 'POST' }))).status).toBe(201);
    expect((await route(request())).status).toBe(200);
  });

  it('honours an explicit status', async () => {
    const route = defineRoute({ status: 202, handler: async () => ({}) });
    expect((await route(request('http://localhost/x', { method: 'POST' }))).status).toBe(202);
  });
});
