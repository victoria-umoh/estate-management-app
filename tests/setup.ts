/**
 * Global Vitest setup.
 *
 * Environment variables are assigned at MODULE TOP LEVEL, not inside a
 * `beforeAll`. `src/core/config` validates `process.env` when it is imported,
 * and a test file's imports are evaluated before any lifecycle hook runs — so
 * setting them in a hook would be too late and config would refuse to load.
 *
 * This file deliberately does NOT start a database. Most unit tests do not need
 * one, and paying replica-set startup per file would make the suite unusable.
 * Integration tests opt in via `setupTestDatabase()` from
 * `tests/helpers/database.ts`.
 */

// Required by the config schema.
process.env.APP_URL ??= 'http://localhost:3000';
process.env.MONGODB_URI ??= 'mongodb://localhost:27018/estate_test?directConnection=true';

// Deterministic, obviously-fake secrets, so tests never depend on a developer's
// local .env and never accidentally exercise real credentials. The access and
// refresh keys differ because the config schema requires it.
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
