import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { InlineJobQueue } from './inline-queue';
import type { JobQueue } from './types';

export type { JobHandler, JobName, JobOptions, JobPayloadMap, JobQueue } from './types';
export { InlineJobQueue } from './inline-queue';

const log = createLogger('queue');

let instance: JobQueue | undefined;
let pending: Promise<JobQueue> | undefined;

/** Async for the same reason as the cache: dynamic import, not require(). */
export function getQueue(): Promise<JobQueue> {
  pending ??= build();
  return pending;
}

async function build(): Promise<JobQueue> {
  if (instance) return instance;

  if (config.queue.driver === 'bullmq') {
    const { BullMqJobQueue } = await import('./bullmq-queue');
    instance = new BullMqJobQueue(config.queue.redisUrl!);
  } else {
    // cron-route enqueues nothing: scheduled HTTP routes invoke handlers
    // directly, so inline execution is the correct local behaviour.
    instance = new InlineJobQueue();
  }

  log.debug({ driver: config.queue.driver }, 'job queue initialised');
  return instance;
}

export function setQueue(queue: JobQueue | undefined): void {
  instance = queue;
  pending = queue ? Promise.resolve(queue) : undefined;
}
