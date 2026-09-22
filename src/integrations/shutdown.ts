import { disconnectFromDatabase } from '@/core/db';
import { getCache } from '@/integrations/cache';
import { getQueue } from '@/integrations/queue';
import { config } from '@/core/config';

/**
 * Close every open connection.
 *
 * Long-running servers do not need this, but short-lived processes — seeders,
 * jobs, benchmarks — do: an open Redis or BullMQ socket keeps the Node event
 * loop alive, so the script finishes its work and then hangs forever with no
 * indication of why.
 *
 * Each close is independent; one failure must not prevent the others, or a
 * single stuck connection still hangs the process.
 */
export async function shutdownIntegrations(): Promise<void> {
  const closers: Array<Promise<unknown>> = [disconnectFromDatabase()];

  // Only touch adapters the configuration actually uses. Calling the getters
  // unconditionally would construct a Redis client purely in order to close it.
  if (config.cache.driver !== 'memory') {
    closers.push(getCache().then((cache) => cache.disconnect()));
  }
  if (config.queue.driver === 'bullmq') {
    closers.push(getQueue().then((queue) => queue.close()));
  }

  await Promise.allSettled(closers);
}
