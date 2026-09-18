/**
 * Blocks until MongoDB is reachable AND reports a healthy replica set primary.
 *
 * Checking for a primary rather than merely a TCP connection matters: the
 * container accepts connections before `rs.initiate()` completes, and a
 * transaction opened in that window fails confusingly.
 *
 *   pnpm db:wait
 */
import mongoose from 'mongoose';

const URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27018/estate_management?directConnection=true';
const TIMEOUT_MS = 60_000;
const INTERVAL_MS = 1_000;

async function main(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await mongoose.connect(URI, { serverSelectionTimeoutMS: 2_000 });
      const status = await mongoose.connection.db!.admin().command({ hello: 1 });

      if (status.isWritablePrimary === true) {
        console.log(`MongoDB ready — replica set "${status.setName ?? 'unknown'}" has a primary.`);
        await mongoose.disconnect();
        return;
      }
      lastError = new Error('connected, but no primary elected yet');
    } catch (error) {
      lastError = error;
    }

    await mongoose.disconnect().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  console.error(`MongoDB not ready after ${TIMEOUT_MS / 1000}s.`);
  console.error('Last error:', lastError instanceof Error ? lastError.message : lastError);
  console.error('\nIs the stack up?  docker compose up -d');
  process.exit(1);
}

void main();
