import { createLogger } from '@/core/logging';
import type { JobHandler, JobName, JobOptions, JobPayloadMap, JobQueue } from './types';

const log = createLogger('queue:inline');

/**
 * Runs jobs immediately, in process.
 *
 * For tests and local development only. There is no persistence and no retry,
 * so a crash loses the job — which is exactly what the queue exists to prevent
 * in production.
 */
export class InlineJobQueue implements JobQueue {
  private readonly handlers = new Map<JobName, JobHandler<never>>();

  register<TName extends JobName>(name: TName, handler: JobHandler<TName>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async enqueue<TName extends JobName>(
    name: TName,
    payload: JobPayloadMap[TName],
    options: JobOptions = {},
  ): Promise<void> {
    const handler = this.handlers.get(name) as JobHandler<TName> | undefined;

    if (!handler) {
      log.warn({ job: name }, 'no handler registered; job discarded');
      return;
    }

    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));

    try {
      await handler(payload);
    } catch (error) {
      // Contained: a failing notification must not fail the request that
      // triggered it. In production BullMQ would retry instead.
      log.error({ err: error, job: name }, 'inline job failed');
    }
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
