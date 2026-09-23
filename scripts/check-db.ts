/**
 * Verify the configured database is reachable and usable.
 *
 * Checks four things, because connecting proves very little on its own: that we
 * can connect, that the deployment is a replica set, that the user can write,
 * and that a transaction can commit. Every financial and critical state change
 * depends on the last one, and a cluster that connects but cannot transact
 * fails much later and far more confusingly.
 *
 *   pnpm db:check
 */
import mongoose from 'mongoose';
import { config } from '@/core/config';

function maskUri(uri: string): string {
  return uri.replace(/\/\/[^@]*@/, '//***:***@');
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not authorized|requires authentication|Authentication failed/i.test(message);
}

async function main(): Promise<void> {
  console.log(`\nChecking ${maskUri(config.db.uri)}`);
  console.log(`Database: ${config.db.name}\n`);

  // --- Connect ---------------------------------------------------------------
  try {
    await mongoose.connect(config.db.uri, {
      dbName: config.db.name,
      serverSelectionTimeoutMS: 15_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('  FAIL  connect —', message);

    // Checked before the generic advice, because the driver states this one
    // plainly and pointing at the IP allowlist instead sends people to the
    // wrong screen entirely.
    if (/directConnection/i.test(message)) {
      console.error('\n  Remove `directConnection=true` from MONGODB_URI. An SRV');
      console.error('  connection string resolves several hosts, so pinning one is');
      console.error('  both rejected by the driver and wrong for a replica set.\n');
    } else if (/ENOTFOUND|querySrv/i.test(message)) {
      console.error('\n  The cluster hostname did not resolve. Check MONGODB_URI.\n');
    } else if (isAuthError(error)) {
      console.error('\n  The username or password was rejected.\n');
    } else {
      console.error("\n  Check that this machine's IP is on the Atlas access list");
      console.error('  (Atlas → Network Access → Add IP Address).\n');
    }
    process.exit(1);
  }
  console.log('    ok  connected');

  // --- Replica set -----------------------------------------------------------
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  const isReplicaSet = Boolean(hello.setName);
  console.log(
    `  ${isReplicaSet ? '  ok' : 'FAIL'}  replica set${
      hello.setName ? ` "${hello.setName}"` : ' — none detected'
    }`,
  );

  // --- Write permission ------------------------------------------------------
  // Checked separately from transactions so an authorisation problem is not
  // misreported as a replica-set problem. They have entirely different fixes.
  const probe = mongoose.connection.collection('__connection_probe');
  let canWrite = false;
  let writeError: unknown;

  try {
    await probe.insertOne({ at: new Date() });
    canWrite = true;
  } catch (error) {
    writeError = error;
  }
  console.log(`  ${canWrite ? '  ok' : 'FAIL'}  write permission`);

  // --- Transactions ----------------------------------------------------------
  let canTransact = false;

  if (canWrite) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await probe.insertOne({ at: new Date(), tx: true }, { session });
      });
      canTransact = true;
    } catch (error) {
      console.error(
        '  FAIL  transactions —',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await session.endSession();
    }

    if (canTransact) console.log('    ok  transactions commit');
    await probe.deleteMany({}).catch(() => {});
  } else {
    console.log('  skip  transactions (cannot write)');
  }

  const collections = await mongoose.connection
    .db!.listCollections()
    .toArray()
    .catch(() => []);
  console.log(`\n  ${collections.length} collection(s) present`);

  await mongoose.disconnect();

  // --- Diagnosis -------------------------------------------------------------
  if (!canWrite) {
    console.error('\n  The cluster is reachable but this user cannot write to');
    console.error(`  "${config.db.name}".`);

    if (isAuthError(writeError)) {
      console.error('\n  In Atlas → Database Access, edit the user and grant it');
      console.error(`  "readWrite" on the "${config.db.name}" database — or`);
      console.error('  "readWriteAnyDatabase" while developing.');
      console.error('\n  A user scoped to a different database name will connect');
      console.error('  successfully and then fail on the first write, which is');
      console.error('  exactly what happened here.\n');
    } else {
      console.error(
        `\n  ${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
      );
    }
    process.exit(1);
  }

  if (!isReplicaSet || !canTransact) {
    console.error('\n  The database is writable but cannot run transactions.');
    console.error('  If MONGODB_URI contains `directConnection=true`, remove it —');
    console.error('  it pins a single host and defeats replica-set awareness.\n');
    process.exit(1);
  }

  console.log('\nDatabase ready.\n');
}

await main();
