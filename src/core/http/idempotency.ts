import { ConflictError } from '@/core/errors';
import { ErrorCode } from '@/core/errors';
import { CacheNamespace, cacheKey, getCache } from '@/integrations/cache';

/**
 * Idempotency for unsafe requests.
 *
 * The motivating case is payment: a resident taps "Pay" twice, or the mobile
 * client retries after a timeout it could not distinguish from a failure. Both
 * must charge once. The same protection covers double-issued visitor passes and
 * duplicated gate entries on a flaky connection.
 *
 * The client supplies an `Idempotency-Key` header; the first request reserves
 * it, later requests with the same key replay the stored response instead of
 * re-executing the handler.
 */

const RESERVATION_TTL_SECONDS = 60 * 60 * 24; // 24h, matching Paystack's window

interface IdempotencyRecord {
  status: 'in-progress' | 'completed';
  /** Fingerprint of the request body, to catch key reuse with different data. */
  fingerprint: string;
  statusCode?: number;
  body?: unknown;
}

function key(scope: { userId: string; route: string; idempotencyKey: string }): string {
  // Scoped per user so one caller's key cannot collide with — or replay —
  // another's response.
  return cacheKey(CacheNamespace.IDEMPOTENCY, scope.userId, scope.route, scope.idempotencyKey);
}

export type IdempotencyOutcome =
  { kind: 'proceed' } | { kind: 'replay'; statusCode: number; body: unknown };

/**
 * Reserve a key before running the handler.
 *
 * - First use: reserves and returns `proceed`.
 * - Repeat of a completed request: returns the stored response to replay.
 * - Repeat while still in flight: 409, because returning an empty success would
 *   be a lie about work that has not finished.
 * - Same key, different body: 409, since replaying the first response for
 *   different data would silently discard the second request.
 */
export async function beginIdempotentRequest(scope: {
  userId: string;
  route: string;
  idempotencyKey: string;
  fingerprint: string;
}): Promise<IdempotencyOutcome> {
  const cache = getCache();
  const cacheId = key(scope);

  const existing = await cache.get<IdempotencyRecord>(cacheId);

  if (existing) {
    if (existing.fingerprint !== scope.fingerprint) {
      throw new ConflictError(
        'This idempotency key was already used with a different request body.',
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
      );
    }

    if (existing.status === 'in-progress') {
      throw new ConflictError(
        'A request with this idempotency key is still being processed.',
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
      );
    }

    return { kind: 'replay', statusCode: existing.statusCode ?? 200, body: existing.body };
  }

  await cache.set<IdempotencyRecord>(
    cacheId,
    { status: 'in-progress', fingerprint: scope.fingerprint },
    RESERVATION_TTL_SECONDS,
  );

  return { kind: 'proceed' };
}

/** Store the response so a later retry with the same key replays it. */
export async function completeIdempotentRequest(
  scope: { userId: string; route: string; idempotencyKey: string; fingerprint: string },
  response: { statusCode: number; body: unknown },
): Promise<void> {
  await getCache().set<IdempotencyRecord>(
    key(scope),
    {
      status: 'completed',
      fingerprint: scope.fingerprint,
      statusCode: response.statusCode,
      body: response.body,
    },
    RESERVATION_TTL_SECONDS,
  );
}

/**
 * Release a reservation after a failure, so the caller can retry.
 *
 * Without this, a transient database error would burn the key and leave the
 * client unable to retry for 24 hours.
 */
export async function releaseIdempotentRequest(scope: {
  userId: string;
  route: string;
  idempotencyKey: string;
}): Promise<void> {
  await getCache().delete(key({ ...scope }));
}

/** Stable fingerprint of a request body. */
export async function fingerprintBody(raw: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(raw).digest('hex');
}
