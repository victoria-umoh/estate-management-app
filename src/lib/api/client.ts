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

async function request<T>(
  path: string,
  init: RequestInit & { retryOnUnauthorised?: boolean } = {},
): Promise<T> {
  const { retryOnUnauthorised = true, ...options } = init;

  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  });

  if (response.status === 401 && retryOnUnauthorised) {
    if (await refreshSession()) {
      return request<T>(path, { ...init, retryOnUnauthorised: false });
    }
  }

  // 204 carries no body by design.
  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!response.ok || !body?.success) {
    throw new ApiRequestError(
      response.status,
      body?.error ?? { code: 'NETWORK_ERROR', message: 'Could not reach the server.' },
    );
  }

  return body.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
