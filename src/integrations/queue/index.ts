import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { InlineJobQueue } from './inline-queue';
import type * as BullMqQueueModule from './bullmq-queue';
import type { JobQueue } from './types';

export type { JobHandler, JobName, JobOptions, JobPayloadMap, JobQueue } from './types';
export { InlineJobQueue } from './inline-queue';

const log = createLogger('queue');

let instance: JobQueue | undefined;

export function getQueue(): JobQueue {
  if (instance) return instance;

  if (config.queue.driver === 'bullmq') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BullMqJobQueue } = require('./bullmq-queue') as typeof BullMqQueueModule;
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
}
