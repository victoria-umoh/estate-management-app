import { createLogger } from '@/core/logging';
import { getCorrelationId } from '@/core/logging';
import type { DomainEvent, DomainEventMap, DomainEventName, EventHandler } from './types';

const log = createLogger('events');

/**
 * In-process domain event bus.
 *
 * Handlers are isolated from each other and from the emitter: a failing
 * notification handler must not roll back the gate entry that triggered it, and
 * one broken subscriber must not starve the others. Failures are logged, never
 * rethrown into the caller.
 *
 * Emission is intentionally fire-and-forget for the same reason. Work that must
 * not be lost belongs on the JobQueue, which persists and retries; the bus is
 * for reacting, not for guaranteeing.
 */
class EventBus {
  private readonly handlers = new Map<DomainEventName, Set<EventHandler<never>>>();

  on<TName extends DomainEventName>(name: TName, handler: EventHandler<TName>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler as EventHandler<never>);
    this.handlers.set(name, set);

    // Returns an unsubscribe function so tests and hot reloads do not stack
    // duplicate handlers.
    return () => {
      set.delete(handler as EventHandler<never>);
    };
  }

  /** Emit without waiting. Handler failures are contained and logged. */
  emit<TName extends DomainEventName>(name: TName, payload: DomainEventMap[TName]): void {
    void this.dispatch(name, payload);
  }

  /**
   * Emit and await every handler.
   *
   * Used by tests and by jobs that genuinely need handlers to finish before
   * the process may exit. Still does not propagate handler failures.
   */
  async emitAsync<TName extends DomainEventName>(
    name: TName,
    payload: DomainEventMap[TName],
  ): Promise<void> {
    await this.dispatch(name, payload);
  }

  private async dispatch<TName extends DomainEventName>(
    name: TName,
    payload: DomainEventMap[TName],
  ): Promise<void> {
    const subscribers = this.handlers.get(name);
    if (!subscribers || subscribers.size === 0) return;

    const event: DomainEvent<TName> = {
      name,
      payload,
      correlationId: getCorrelationId() ?? 'unknown',
      occurredAt: new Date(),
    };

    // allSettled, not all: one rejecting handler must not prevent the rest from
    // running or surface as an unhandled rejection.
    const results = await Promise.allSettled(
      [...subscribers].map(async (handler) => (handler as EventHandler<TName>)(event)),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        log.error({ err: result.reason, event: name }, 'event handler failed');
      }
    }
  }

  /** Test helper — drop all subscriptions. */
  removeAllHandlers(): void {
    this.handlers.clear();
  }

  handlerCount(name: DomainEventName): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

export const events = new EventBus();
