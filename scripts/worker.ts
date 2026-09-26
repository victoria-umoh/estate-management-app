/**
 * Background worker: consumes the outbound email and SMS queue.
 *
 *   pnpm worker
 *
 * The web process registers the same handlers on its first request, so jobs
 * are processed even without this. Running it separately is still the better
 * shape in production: delivery starts the moment the worker is up rather than
 * when someone first loads a page, and a burst of notifications is sent at the
 * worker's pace instead of competing with gate scans for the web process.
 * BullMQ hands each job to exactly one consumer, so both running is safe.
 *
 * Only meaningful with QUEUE_DRIVER=bullmq. The inline driver runs jobs inside
 * the request that enqueued them, so there is nothing here to consume.
 */
import { config } from '@/core/config';
import { connectToDatabase } from '@/core/db';
import { createLogger } from '@/core/logging';
import { shutdownIntegrations } from '@/integrations/shutdown';
import { registerNotificationJobs } from '@/modules/notification';

const log = createLogger('worker');

if (config.queue.driver !== 'bullmq') {
  log.warn(
    { driver: config.queue.driver },
    'QUEUE_DRIVER is not bullmq; there is no queue for a worker to consume. Exiting.',
  );
  process.exit(0);
}

await connectToDatabase();
await registerNotificationJobs();
log.info('worker ready; consuming the notification queue');

let stopping = false;

// Let in-flight jobs finish: closing the queue waits for active handlers, so a
// message half-sent at shutdown is completed rather than dropped and retried.
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  log.info({ signal }, 'worker stopping');
  await shutdownIntegrations();
  process.exit(0);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
