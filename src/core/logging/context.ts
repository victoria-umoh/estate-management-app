import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated without threading it through every signature.
 *
 * The correlation ID is the thread that ties an API request to the service
 * calls, database writes, audit entries and background jobs it triggers — so a
 * support ticket quoting one ID can be traced end to end.
 */
export interface LogContext {
  correlationId: string;
  userId?: string;
  estateId?: string;
  /** Route pattern, e.g. `POST /api/v1/visitors`. */
  route?: string;
  ip?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Run `fn` with the given context bound to it and everything it awaits. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Merge fields into the active context.
 *
 * Used once a request authenticates, so log lines emitted before and after
 * authentication can both be attributed.
 */
export function enrichLogContext(fields: Partial<LogContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}
