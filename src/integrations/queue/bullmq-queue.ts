import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { createLogger } from '@/core/logging';
import type { JobHandler, JobName, JobOptions, JobPayloadMap, JobQueue } from './types';

const log = createLogger('queue:bullmq');

/**
 * Redis-backed queue with real persistence, retries and backoff.
 *
 * Jobs are produced by the web process and consumed by a separate worker
 * (`pnpm worker`), so a slow email provider cannot occupy a request handler.
 */
export class BullMqJobQueue implements JobQueue {
  private readonly queues = new Map<JobName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: ConnectionOptions;

  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: url.password } : {}),
    };
  }

  private queueFor(name: JobName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          // Exponential backoff: a provider outage should not be hammered.
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1_000 },
          // Keep failures around for investigation rather than discarding them.
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<TName extends JobName>(
    name: TName,
    payload: JobPayloadMap[TName],
    options: JobOptions = {},
  ): Promise<void> {
    await this.queueFor(name).add(name, payload, {
      ...(options.delayMs ? { delay: options.delayMs } : {}),
      ...(options.attempts ? { attempts: options.attempts } : {}),
      // BullMQ collapses jobs sharing a jobId, which is how a dedupeKey stops
      // duplicate sweeps piling up.
      ...(options.dedupeKey ? { jobId: options.dedupeKey } : {}),
    });
  }

  register<TName extends JobName>(name: TName, handler: JobHandler<TName>): void {
    const worker = new Worker(name, async (job) => handler(job.data as JobPayloadMap[TName]), {
      connection: this.connection,
      concurrency: 5,
    });

    worker.on('failed', (job, error) => {
      log.error({ err: error, job: name, attempts: job?.attemptsMade }, 'job failed');
    });

    this.workers.push(worker);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
