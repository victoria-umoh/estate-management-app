/**
 * Create every index the application depends on.
 *
 * Mongoose runs with `autoIndex: false`, because building indexes implicitly on
 * first model use causes surprise index builds under production load. The
 * consequence is that indexes must be created deliberately — and if this never
 * runs, a fresh database has **no unique constraints at all**.
 *
 * That is not a performance footnote. Without them the same email, NIN, phone
 * number or number plate can be registered twice, and the duplicate detection
 * the identity design rests on silently does nothing.
 *
 * Run after every deploy, and before seeding.
 *
 *   pnpm db:indexes
 */
import { connectToDatabase } from '@/core/db';
import { shutdownIntegrations } from '@/integrations/shutdown';
import { MODEL_COUNT, syncIndexes } from './sync-indexes-lib';

async function main(): Promise<void> {
  await connectToDatabase();

  console.log(`\nSynchronising indexes for ${MODEL_COUNT} collections\n`);

  const { indexes, unique, failures } = await syncIndexes();

  console.log(`\n  ${indexes} indexes total, ${unique} of them unique`);

  await shutdownIntegrations();

  if (failures.length > 0) {
    console.error(`\n  Failed: ${failures.join(', ')}`);
    console.error('\n  A unique index will fail to build if the collection already');
    console.error('  contains duplicates. Resolve those first, then re-run.\n');
    process.exit(1);
  }

  console.log('\nIndexes ready.\n');
}

await main();
