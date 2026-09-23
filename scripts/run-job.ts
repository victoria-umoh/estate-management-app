/**
 * Run a scheduled job once, from the command line.
 *
 * Used by cron, by the deployment's scheduler, and for testing a job against
 * real data without waiting for its next tick.
 *
 *   pnpm job:overstay
 *   pnpm tsx scripts/run-job.ts overstay-sweep
 */
import { connectToDatabase } from '@/core/db';
import { shutdownIntegrations } from '@/integrations/shutdown';

const JOBS = {
  'overstay-sweep': async () => {
    const { runOverstaySweep } = await import('@/jobs/overstay-sweep');
    return runOverstaySweep();
  },
  'billing-run': async () => {
    const { runBilling } = await import('@/jobs/billing-run');
    // --force bills regardless of the due day, for a first run or a demo.
    return runBilling(new Date(), process.argv.includes('--force'));
  },
  'mark-overdue': async () => {
    const { runOverdueSweep } = await import('@/jobs/billing-run');
    return runOverdueSweep();
  },
  dunning: async () => {
    const { subscriptionService } = await import('@/modules/subscription');
    return subscriptionService.runDunning();
  },
  'sla-sweep': async () => {
    const { serviceRequestService } = await import('@/modules/service-request');
    return serviceRequestService.escalateOverdue();
  },
} as const;

type JobName = keyof typeof JOBS;

async function main(): Promise<void> {
  const name = process.argv[2] as JobName | undefined;

  if (!name || !(name in JOBS)) {
    console.error(`Usage: pnpm tsx scripts/run-job.ts <${Object.keys(JOBS).join('|')}>`);
    process.exit(1);
  }

  const startedAt = Date.now();
  await connectToDatabase();

  try {
    const result = await JOBS[name]();
    console.log(`${name} completed in ${Date.now() - startedAt}ms`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`${name} failed:`, error);
    process.exitCode = 1;
  } finally {
    await shutdownIntegrations();
  }
}

await main();
