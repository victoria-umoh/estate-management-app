import { describe, expect, it } from 'vitest';
import { envSchema } from './schema';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const KEY_D = 'd'.repeat(64);

/** Minimal environment that validates, so each test varies exactly one thing. */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'development',
    APP_URL: 'http://localhost:3000',
    MONGODB_URI: 'mongodb://localhost:27018/estate?directConnection=true',
    JWT_ACCESS_SECRET: KEY_A,
    JWT_REFRESH_SECRET: KEY_B,
    ENCRYPTION_KEY: KEY_C,
    ENCRYPTION_BLIND_INDEX_KEY: KEY_D,
    QR_SIGNING_SECRET: KEY_A,
    ...overrides,
  };
}

/** Collect the field paths that failed, for concise assertions. */
function failedPaths(env: Record<string, string>): string[] {
  const result = envSchema.safeParse(env);
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

describe('envSchema — baseline', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const result = envSchema.safeParse(baseEnv());
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.CACHE_DRIVER).toBe('memory');
      expect(result.data.JWT_ACCESS_TTL).toBe('15m');
      expect(result.data.DEFAULT_CURRENCY).toBe('NGN');
      expect(result.data.IDENTITY_REQUIRE_NIN_VERIFICATION).toBe(true);
    }
  });

  it('parses comma-separated lists into arrays', () => {
    const result = envSchema.safeParse(
      baseEnv({ CORS_ALLOWED_ORIGINS: 'https://a.com, https://b.com ,' }),
    );
    expect(result.success && result.data.CORS_ALLOWED_ORIGINS).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
});

describe('envSchema — secret strength', () => {
  it.each([
    ['JWT_ACCESS_SECRET', 'tooshort'],
    ['ENCRYPTION_KEY', 'zz'.repeat(32)], // 64 chars but not hex
    ['ENCRYPTION_BLIND_INDEX_KEY', 'a'.repeat(63)], // one char short
  ])('rejects a weak %s', (field, value) => {
    expect(failedPaths(baseEnv({ [field]: value }))).toContain(field);
  });

  // If both JWT keys were equal, leaking the short-lived access key would also
  // let an attacker mint 30-day refresh tokens.
  it('rejects identical access and refresh signing keys', () => {
    expect(failedPaths(baseEnv({ JWT_REFRESH_SECRET: KEY_A }))).toContain('JWT_REFRESH_SECRET');
  });
});

describe('envSchema — driver credentials', () => {
  it('requires REDIS_URL when the cache driver is ioredis', () => {
    expect(failedPaths(baseEnv({ CACHE_DRIVER: 'ioredis' }))).toContain('REDIS_URL');
    expect(
      failedPaths(baseEnv({ CACHE_DRIVER: 'ioredis', REDIS_URL: 'redis://localhost:6381' })),
    ).toEqual([]);
  });

  it('requires both Upstash values when the cache driver is upstash', () => {
    const paths = failedPaths(baseEnv({ CACHE_DRIVER: 'upstash' }));
    expect(paths).toContain('UPSTASH_REDIS_REST_URL');
    expect(paths).toContain('UPSTASH_REDIS_REST_TOKEN');
  });

  // Without this secret, anyone who guessed the cron URL could trigger a
  // billing run or an overstay sweep.
  it('requires CRON_SECRET when jobs run as HTTP cron routes', () => {
    expect(failedPaths(baseEnv({ QUEUE_DRIVER: 'cron-route' }))).toContain('CRON_SECRET');
  });

  it('requires bucket and credentials when storage is s3', () => {
    const paths = failedPaths(baseEnv({ STORAGE_DRIVER: 's3' }));
    expect(paths).toEqual(
      expect.arrayContaining(['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']),
    );
  });

  it.each([
    ['EMAIL_DRIVER', 'resend', 'RESEND_API_KEY'],
    ['EMAIL_DRIVER', 'sendgrid', 'SENDGRID_API_KEY'],
    ['SMS_DRIVER', 'termii', 'TERMII_API_KEY'],
    ['IDENTITY_DRIVER', 'dojah', 'DOJAH_API_KEY'],
    ['IDENTITY_DRIVER', 'prembly', 'PREMBLY_API_KEY'],
  ])('requires credentials when %s=%s', (driver, value, required) => {
    expect(failedPaths(baseEnv({ [driver]: value }))).toContain(required);
  });
});

describe('envSchema — production guards', () => {
  const prod = (overrides: Record<string, string> = {}) =>
    baseEnv({
      NODE_ENV: 'production',
      APP_URL: 'https://estate.example.com',
      CACHE_DRIVER: 'ioredis',
      REDIS_URL: 'redis://localhost:6379',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'docs',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      EMAIL_DRIVER: 'resend',
      RESEND_API_KEY: 'rk',
      SMS_DRIVER: 'termii',
      TERMII_API_KEY: 'tk',
      IDENTITY_DRIVER: 'dojah',
      DOJAH_APP_ID: 'app',
      DOJAH_API_KEY: 'key',
      ...overrides,
    });

  it('accepts a correctly configured production environment', () => {
    expect(failedPaths(prod())).toEqual([]);
  });

  it('rejects plaintext HTTP, because session cookies are issued Secure', () => {
    expect(failedPaths(prod({ APP_URL: 'http://estate.example.com' }))).toContain('APP_URL');
  });

  // The mock verifier accepts any 11-digit NIN. In production that would mean
  // unverified residents holding verified-looking estate IDs.
  it('rejects the mock identity verifier', () => {
    expect(failedPaths(prod({ IDENTITY_DRIVER: 'mock' }))).toContain('IDENTITY_DRIVER');
  });

  // In-process cache means each instance keeps its own counters, so an attacker
  // gets N times the intended login attempts across N instances.
  it('rejects the in-memory cache driver', () => {
    expect(failedPaths(prod({ CACHE_DRIVER: 'memory' }))).toContain('CACHE_DRIVER');
  });

  it('rejects local filesystem storage for resident documents', () => {
    expect(failedPaths(prod({ STORAGE_DRIVER: 'local' }))).toContain('STORAGE_DRIVER');
  });

  // console drivers discard the message; OTPs and emergency alerts would
  // silently never arrive.
  it.each(['EMAIL_DRIVER', 'SMS_DRIVER'])('rejects the console %s', (field) => {
    expect(failedPaths(prod({ [field]: 'console' }))).toContain(field);
  });

  it('allows these same settings outside production', () => {
    expect(failedPaths(baseEnv({ IDENTITY_DRIVER: 'mock', CACHE_DRIVER: 'memory' }))).toEqual([]);
  });
});

describe('envSchema — bounds', () => {
  it('rejects a min pool size larger than the max', () => {
    expect(
      failedPaths(baseEnv({ MONGODB_MIN_POOL_SIZE: '50', MONGODB_MAX_POOL_SIZE: '10' })),
    ).toContain('MONGODB_MIN_POOL_SIZE');
  });

  it('rejects malformed durations', () => {
    expect(failedPaths(baseEnv({ JWT_ACCESS_TTL: '15 minutes' }))).toContain('JWT_ACCESS_TTL');
  });

  it('caps presigned URL lifetime at one hour', () => {
    expect(failedPaths(baseEnv({ S3_PRESIGN_EXPIRY_SECONDS: '7200' }))).toContain(
      'S3_PRESIGN_EXPIRY_SECONDS',
    );
  });

  it('requires a New Relic licence key when the agent is enabled', () => {
    expect(failedPaths(baseEnv({ NEW_RELIC_ENABLED: 'true' }))).toContain('NEW_RELIC_LICENSE_KEY');
  });
});
