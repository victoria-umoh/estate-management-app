'use client';

/**
 * Browser API client.
 *
 * Holds no tokens. The session lives in httpOnly cookies the browser attaches
 * automatically, so there is nothing here for an injected script to steal.
 *
 * On a 401 it attempts one refresh and retries once. Concurrent 401s share that
 * single refresh rather than each firing their own — without which a dashboard
 * loading six panels would rotate the refresh token six times and trip the
 * reuse detection, logging the user out for being busy.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: Array<{ field?: string; message: string }>;
  requestId?: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiError['details'];
  readonly requestId: string | undefined;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = error.code;
    this.details = error.details;
    this.requestId = error.requestId;
  }
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: Record<string, unknown>;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

/** A page of results, with the envelope's pagination meta kept intact. */
export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

async function request<T>(
  path: string,
  init: RequestInit & { retryOnUnauthorised?: boolean } = {},
): Promise<T> {
  return (await requestWithMeta<T>(path, init)).data;
}

/**
 * Whether a 401 is about the session rather than the request.
 *
 * Only a missing or stale access token is cured by refreshing. A wrong current
 * password or a spent OTP is also a 401, and retrying it sends the same bad
 * guess twice — burning two of the caller's rate-limited attempts and rotating
 * the refresh token for nothing.
 */
const SESSION_FAILURES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_INVALID']);

async function isSessionFailure(response: Response): Promise<boolean> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string } } | null;
  return SESSION_FAILURES.has(body?.error?.code ?? 'UNAUTHENTICATED');
}

async function requestWithMeta<T>(
  path: string,
  init: RequestInit & { retryOnUnauthorised?: boolean } = {},
): Promise<{ data: T; meta: Record<string, unknown> | undefined }> {
  const { retryOnUnauthorised = true, ...options } = init;

  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  });

  if (response.status === 401 && retryOnUnauthorised && (await isSessionFailure(response))) {
    if (await refreshSession()) {
      return requestWithMeta<T>(path, { ...init, retryOnUnauthorised: false });
    }
  }

  // 204 carries no body by design.
  if (response.status === 204) return { data: undefined as T, meta: undefined };

  const body = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!response.ok || !body?.success) {
    throw new ApiRequestError(
      response.status,
      body?.error ?? { code: 'NETWORK_ERROR', message: 'Could not reach the server.' },
    );
  }

  return { data: body.data as T, meta: body.meta };
}

const DEFAULT_META: PageMeta = {
  page: 1,
  limit: 0,
  total: 0,
  totalPages: 1,
  hasNextPage: false,
};

export const api = {
  get: <T>(path: string) => request<T>(path),

  /**
   * A paginated GET, keeping the envelope's `meta`.
   *
   * `get` returns only `data`, which for a paginated route is the bare array —
   * so a caller using it has no total and no way to know whether another page
   * exists. Screens were working around that by inferring "there is more" from
   * a full page coming back, which costs a wasted request at every exact
   * multiple of the page size and can never show a total.
   */
  getPage: async <T>(path: string): Promise<Page<T>> => {
    const { data, meta } = await requestWithMeta<T[]>(path);
    return { items: data ?? [], meta: { ...DEFAULT_META, ...(meta as Partial<PageMeta>) } };
  },

  post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) =>
    request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      // Routes declaring `idempotent: true` read this header. Without it a
      // retry after a timeout is processed as a second, separate request.
      ...(options?.idempotencyKey
        ? { headers: { 'idempotency-key': options.idempotencyKey } }
        : {}),
    }),

  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),

  // Replaces the whole resource — e.g. a resident's full role set.
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),

  delete: <T>(path: string, options?: { idempotencyKey?: string }) =>
    request<T>(path, {
      method: 'DELETE',
      // Close and escalate are DELETEs that declare `idempotent: true`; without
      // a key a retry after a timeout is processed as a second request.
      ...(options?.idempotencyKey
        ? { headers: { 'idempotency-key': options.idempotencyKey } }
        : {}),
    }),
};
