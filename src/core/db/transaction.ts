import mongoose, { type ClientSession } from 'mongoose';
import { createLogger } from '@/core/logging';

const log = createLogger('db:transaction');

/**
 * Run `fn` inside a MongoDB transaction.
 *
 * Every financial operation and every multi-collection state change goes
 * through here. A payment that credits a ledger but fails to mark its invoice
 * paid is worse than a payment that fails outright, because the first is silent.
 *
 * Requires a replica set — see docker-compose.yml and tests/helpers/database.ts.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();

  try {
    let result: T;
    // withTransaction retries automatically on transient errors and on commit
    // failures caused by write conflicts, which happen under concurrent gate
    // and billing writes.
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } catch (error) {
    log.error({ err: error }, 'transaction aborted');
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Join an existing transaction, or start one.
 *
 * Lets a service be called standalone or as part of a larger atomic operation
 * without the caller having to know which.
 */
export async function withOptionalTransaction<T>(
  session: ClientSession | undefined,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  if (session) return fn(session);
  return withTransaction(fn);
}
