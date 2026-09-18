/**
 * In-memory MongoDB harness for integration tests.
 *
 * Starts a single-node REPLICA SET, not a standalone server: the platform uses
 * multi-document transactions for financial and critical state changes, and a
 * standalone mongod would make those tests pass for the wrong reason (or fail
 * with an unrelated error).
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll } from 'vitest';

let replSet: MongoMemoryReplSet | undefined;

/** Call at the top of an integration test file to get a clean database per test. */
export function setupTestDatabase(): void {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await mongoose.connect(replSet.getUri(), { dbName: 'test' });
  }, 120_000);

  // Drop data rather than the database so indexes — including the unique
  // constraints that enforce duplicate-identity detection — survive between
  // tests and stay under test themselves.
  afterEach(async () => {
    const { collections } = mongoose.connection;
    await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });
}
