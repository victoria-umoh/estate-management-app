import mongoose from 'mongoose';
import { config } from '@/core/config';
import { createLogger } from '@/core/logging';

const log = createLogger('db');

/**
 * Mongoose connection, cached across hot reloads and serverless invocations.
 *
 * Next.js re-evaluates modules on every reload in development and may reuse a
 * warm container in production; without this cache each one would open a new
 * pool and exhaust the server's connection limit.
 */
declare global {
  var __mongooseConnection: Promise<typeof mongoose> | undefined;
}

// Reject queries referencing fields absent from the schema, rather than
// silently dropping them — a dropped `estateId` would widen a query.
mongoose.set('strictQuery', 'throw');

// Indexes are created explicitly via `pnpm db:indexes`, not implicitly on model
// use: autoIndex in production causes surprise index builds under load.
mongoose.set('autoIndex', false);

// Bound every read so a missing index cannot stall the gate path indefinitely.
// maxTimeMS is a query option rather than a connection option, so it is applied
// globally here instead of being repeated — and forgotten — at call sites.
mongoose.plugin((schema) => {
  schema.pre(
    ['find', 'findOne', 'findOneAndUpdate', 'countDocuments', 'distinct'],
    function applyMaxTime(this: { maxTimeMS: (ms: number) => unknown }) {
      this.maxTimeMS(config.db.maxTimeMs);
    },
  );
});

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (global.__mongooseConnection) return global.__mongooseConnection;

  const promise = mongoose
    .connect(config.db.uri, {
      dbName: config.db.name,
      maxPoolSize: config.db.maxPoolSize,
      minPoolSize: config.db.minPoolSize,
      serverSelectionTimeoutMS: 10_000,
      retryWrites: true,
    })
    .then((connection) => {
      log.info({ database: config.db.name }, 'connected to MongoDB');
      return connection;
    })
    .catch((error: unknown) => {
      // Clear the cache so the next request retries instead of awaiting a
      // permanently rejected promise.
      global.__mongooseConnection = undefined;
      log.error({ err: error }, 'failed to connect to MongoDB');
      throw error;
    });

  global.__mongooseConnection = promise;
  return promise;
}

export async function disconnectFromDatabase(): Promise<void> {
  if (!global.__mongooseConnection) return;
  await mongoose.disconnect();
  global.__mongooseConnection = undefined;
}

export { mongoose };
