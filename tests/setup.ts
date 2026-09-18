/**
 * Global Vitest setup.
 *
 * Deliberately does NOT start a database. Most unit tests do not need one, and
 * paying replica-set startup for every file would make the suite unusable.
 * Integration tests opt in explicitly via `useTestDatabase()` from
 * `tests/helpers/database.ts`.
 */
import { beforeAll } from 'vitest';

beforeAll(() => {
  // NODE_ENV is set to 'test' by Vitest itself and is typed read-only.

  // Deterministic, obviously-fake secrets so tests never depend on a developer's
  // local .env and never accidentally exercise real credentials.
  process.env.JWT_ACCESS_SECRET ??= 'a'.repeat(64);
  process.env.JWT_REFRESH_SECRET ??= 'b'.repeat(64);
  process.env.ENCRYPTION_KEY ??= 'c'.repeat(64);
  process.env.ENCRYPTION_BLIND_INDEX_KEY ??= 'd'.repeat(64);
  process.env.QR_SIGNING_SECRET ??= 'e'.repeat(64);
  process.env.CRON_SECRET ??= 'f'.repeat(64);

  // In-process adapters keep tests hermetic: no Redis, no S3, no network.
  process.env.CACHE_DRIVER ??= 'memory';
  process.env.QUEUE_DRIVER ??= 'inline';
  process.env.STORAGE_DRIVER ??= 'local';
  process.env.EMAIL_DRIVER ??= 'console';
  process.env.SMS_DRIVER ??= 'console';
  process.env.IDENTITY_DRIVER ??= 'mock';
  process.env.LOG_LEVEL ??= 'silent';
});
