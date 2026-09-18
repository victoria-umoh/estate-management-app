import { NextResponse } from 'next/server';
import type { SerializedError } from '@/core/errors';

/**
 * One response shape for the entire API.
 *
 * Mobile clients will consume these same endpoints, so the envelope has to be
 * predictable enough to decode generically: `success` discriminates, `data`
 * carries the payload, `error` carries a stable code, and `meta` carries
 * pagination without polluting the payload.
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: ResponseMeta;
}

export interface ApiFailure {
  success: false;
  error: SerializedError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ResponseMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  requestId?: string;
}

export function ok<T>(data: T, meta?: ResponseMeta, status = 200): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ success: true as const, data, ...(meta ? { meta } : {}) }, { status });
}

export function created<T>(data: T, meta?: ResponseMeta): NextResponse<ApiSuccess<T>> {
  return ok(data, meta, 201);
}

/** 204 carries no body, so there is deliberately no envelope here. */
export function noContent(): NextResponse<null> {
  return new NextResponse(null, { status: 204 }) as NextResponse<null>;
}

export function fail(
  error: SerializedError,
  status: number,
  headers?: Record<string, string>,
): NextResponse<ApiFailure> {
  return NextResponse.json({ success: false as const, error }, { status, headers });
}

/** Convert a repository page into an envelope, keeping meta out of the payload. */
export function paginated<T>(result: {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}): NextResponse<ApiSuccess<T[]>> {
  const { items, ...meta } = result;
  return ok(items, meta);
}
