/**
 * Gate verification benchmark.
 *
 * The gate path is the one operation in this system with a hard latency budget,
 * and a budget nobody measures is a wish. This runs verification against a real
 * MongoDB replica set populated with a realistic number of credentials, and
 * fails if p95 exceeds the budget.
 *
 *   pnpm bench:gate
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.APP_URL ??= 'http://localhost:3000';
process.env.MONGODB_URI ??= 'mongodb://localhost:27018/bench?directConnection=true';
process.env.JWT_ACCESS_SECRET ??= 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET ??= 'b'.repeat(64);
process.env.ENCRYPTION_KEY ??= 'c'.repeat(64);
process.env.ENCRYPTION_BLIND_INDEX_KEY ??= 'd'.repeat(64);
process.env.QR_SIGNING_SECRET ??= 'e'.repeat(64);
process.env.CACHE_DRIVER ??= 'memory';
process.env.LOG_LEVEL ??= 'silent';

const { issueToken, hashToken } = await import('@/core/crypto');
const { AccessCredentialModel } = await import('@/modules/credential/schema');
const { verifyScan } = await import('@/modules/credential/verification');

/**
 * Budgets in milliseconds. Cold means a database read; warm means a cache hit.
 *
 * Set close to observed values rather than comfortably above them. A budget
 * with an order of magnitude of headroom catches nothing — an extra round trip
 * would slip under it unnoticed. These leave room for a slower CI machine and
 * little else.
 */
const BUDGET = { coldP95: 8, warmP95: 2 };

/** Credentials to seed. A large estate, so the index is doing real work. */
const CREDENTIAL_COUNT = 5_000;
const SAMPLES = 500;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function report(label: string, timings: number[], budget: number): boolean {
  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const p99 = percentile(timings, 99);
  const pass = p95 <= budget;

  console.log(
    `  ${pass ? '  ok' : 'FAIL'}  ${label.padEnd(22)} ` +
      `p50 ${p50.toFixed(2)}ms   p95 ${p95.toFixed(2)}ms   p99 ${p99.toFixed(2)}ms   ` +
      `(budget p95 ${budget}ms)`,
  );

  return pass;
}

async function main(): Promise<void> {
  console.log('\nGate verification benchmark\n');
  process.stdout.write('  starting replica set… ');

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 60_000 }],
  });
  await mongoose.connect(replSet.getUri(), { dbName: 'bench' });
  await AccessCredentialModel.syncIndexes();
  console.log('done');

  const estateId = new mongoose.Types.ObjectId();
  process.stdout.write(`  seeding ${CREDENTIAL_COUNT.toLocaleString()} credentials… `);

  const tokens: string[] = [];
  const documents = [];

  for (let index = 0; index < CREDENTIAL_COUNT; index++) {
    const { token, payload } = issueToken({
      sub: 'resident',
      cid: new mongoose.Types.ObjectId().toHexString(),
      est: estateId.toHexString(),
      ttlSeconds: 86_400,
    });

    tokens.push(token);
    documents.push({
      estateId,
      tokenHash: hashToken(token),
      jti: payload.jti,
      subject: 'resident',
      subjectId: new mongoose.Types.ObjectId(),
      display: {
        primaryLabel: `Resident ${index}`,
        secondaryLabel: null,
        unitNumber: `${index % 400}B`,
        category: 'Homeowner',
        photoUrl: null,
      },
      status: 'active',
      blacklisted: false,
      validFrom: new Date(Date.now() - 3_600_000),
      validUntil: null,
      version: 1,
      issuedAt: new Date(),
      issuedBy: new mongoose.Types.ObjectId(),
      syncedAt: new Date(),
    });
  }

  await AccessCredentialModel.insertMany(documents);
  console.log('done\n');

  const sample = () => tokens[Math.floor(Math.random() * tokens.length)]!;

  // --- Index check ----------------------------------------------------------
  // The deterministic half of this benchmark. A timing budget catches a lost
  // index only if the collection is large enough on the day; an explain plan
  // catches it always. A collection scan here would mean every gate scan reads
  // every credential in the estate.
  const plan = await AccessCredentialModel.collection
    .find({ tokenHash: hashToken(tokens[0]!) })
    .explain('queryPlanner');

  const winningStage = JSON.stringify(
    (plan as { queryPlanner?: { winningPlan?: unknown } }).queryPlanner?.winningPlan ?? {},
  );
  const usesIndex = winningStage.includes('IXSCAN');

  console.log(
    `  ${usesIndex ? '  ok' : 'FAIL'}  ${'index lookup'.padEnd(22)} ` +
      `${usesIndex ? 'IXSCAN on tokenHash' : 'COLLSCAN — the gate index is not being used'}`,
  );
  console.log('');

  // --- Cold: every scan is a distinct token, so the cache never helps --------
  const { setCache, MemoryCacheAdapter } = await import('@/integrations/cache');

  const coldTimings: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    // Fresh cache per iteration, so each measurement is a genuine database read.
    setCache(new MemoryCacheAdapter());
    const token = sample();

    const started = performance.now();
    await verifyScan(token, estateId.toHexString());
    coldTimings.push(performance.now() - started);
  }

  // --- Warm: the repeat scans a real gate actually sees ----------------------
  setCache(new MemoryCacheAdapter());
  const warmToken = sample();
  await verifyScan(warmToken, estateId.toHexString());

  const warmTimings: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now();
    await verifyScan(warmToken, estateId.toHexString());
    warmTimings.push(performance.now() - started);
  }

  // --- Forged: must cost nothing, since it does no I/O ----------------------
  const forgedTimings: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now();
    await verifyScan('v1.forged.signature', estateId.toHexString());
    forgedTimings.push(performance.now() - started);
  }

  const results = [
    usesIndex,
    report('cold (db read)', coldTimings, BUDGET.coldP95),
    report('warm (cache hit)', warmTimings, BUDGET.warmP95),
    report('forged (no i/o)', forgedTimings, BUDGET.warmP95),
  ];

  await mongoose.disconnect();
  await replSet.stop();

  if (results.includes(false)) {
    console.error('\nGate verification check failed.\n');
    console.error('The gate path must stay fast on a cheap tablet over a poor');
    console.error('connection. Check for a lookup added to the verification path,');
    console.error('or an index that is no longer being used.\n');
    process.exit(1);
  }

  console.log('\nGate verification within budget.\n');
}

await main();
