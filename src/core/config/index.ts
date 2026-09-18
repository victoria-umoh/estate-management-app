import type { ZodError } from 'zod';
import { parseDuration } from './duration';
import { envSchema, type Env } from './schema';

export { parseDuration, formatDuration, isValidDuration } from './duration';
export type { Env } from './schema';

/**
 * Typed application configuration.
 *
 * SERVER ONLY. The ESLint layering rule stops components importing this, because
 * it holds every secret the platform has.
 *
 * Durations are pre-parsed to milliseconds here so no call site has to remember
 * to convert, and derived booleans (`isProduction`, `sentry.enabled`) are
 * resolved once rather than re-derived inconsistently across the codebase.
 */

function formatValidationFailure(error: ZodError): string {
  const issues = error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  return [
    '',
    '─'.repeat(72),
    ' INVALID ENVIRONMENT CONFIGURATION — refusing to start',
    '─'.repeat(72),
    '',
    issues,
    '',
    ' Fix:',
    '   1. cp .env.example .env.local     (if you have not already)',
    '   2. pnpm keys:generate             (generates every required secret)',
    '   3. paste the generated values into .env.local',
    '',
    '─'.repeat(72),
    '',
  ].join('\n');
}

function load(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Thrown, not logged-and-defaulted. Booting with a broken payment key or a
    // missing encryption key is strictly worse than not booting.
    throw new Error(formatValidationFailure(result.error));
  }

  return result.data;
}

const env = load();

export const config = {
  env,

  app: {
    name: env.APP_NAME,
    url: env.APP_URL,
    supportEmail: env.APP_SUPPORT_EMAIL,
    corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
    runtimeTarget: env.RUNTIME_TARGET,
  },

  isProduction: env.NODE_ENV === 'production',
  isDevelopment: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',

  db: {
    uri: env.MONGODB_URI,
    name: env.MONGODB_DB_NAME,
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    minPoolSize: env.MONGODB_MIN_POOL_SIZE,
    maxTimeMs: env.MONGODB_MAX_TIME_MS,
  },

  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtlMs: parseDuration(env.JWT_ACCESS_TTL),
    refreshTtlMs: parseDuration(env.JWT_REFRESH_TTL),
    maxFailedAttempts: env.AUTH_MAX_FAILED_ATTEMPTS,
    lockoutMs: parseDuration(env.AUTH_LOCKOUT_DURATION),
    otp: {
      length: env.OTP_LENGTH,
      ttlMs: parseDuration(env.OTP_TTL),
      maxAttempts: env.OTP_MAX_ATTEMPTS,
    },
    totpIssuer: env.TOTP_ISSUER,
    argon2: {
      memoryCost: env.ARGON2_MEMORY_COST,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
  },

  crypto: {
    encryptionKey: env.ENCRYPTION_KEY,
    encryptionKeyVersion: env.ENCRYPTION_KEY_VERSION,
    blindIndexKey: env.ENCRYPTION_BLIND_INDEX_KEY,
    qrSigningSecret: env.QR_SIGNING_SECRET,
  },

  cache: {
    driver: env.CACHE_DRIVER,
    redisUrl: env.REDIS_URL,
    upstashUrl: env.UPSTASH_REDIS_REST_URL,
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN,
    gateTtlSeconds: env.GATE_CACHE_TTL_SECONDS,
  },

  rateLimit: {
    defaultPerMinute: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
    anonymousPerMinute: env.RATE_LIMIT_ANONYMOUS_PER_MINUTE,
  },

  queue: {
    driver: env.QUEUE_DRIVER,
    redisUrl: env.REDIS_URL,
    cronSecret: env.CRON_SECRET,
  },

  storage: {
    driver: env.STORAGE_DRIVER,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    presignExpirySeconds: env.S3_PRESIGN_EXPIRY_SECONDS,
    maxFileSizeBytes: env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024,
    allowedMimeTypes: env.UPLOAD_ALLOWED_MIME_TYPES,
    clamav:
      env.CLAMAV_HOST && env.CLAMAV_PORT
        ? { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT }
        : undefined,
  },

  payments: {
    paystack: {
      secretKey: env.PAYSTACK_SECRET_KEY,
      publicKey: env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      // Paystack signs webhooks with the secret key unless a distinct webhook
      // secret is configured.
      webhookSecret: env.PAYSTACK_WEBHOOK_SECRET ?? env.PAYSTACK_SECRET_KEY,
      callbackUrl: env.PAYSTACK_CALLBACK_URL,
      platformCommissionPercent: env.PAYSTACK_PLATFORM_COMMISSION_PERCENT,
    },
    defaultCurrency: env.DEFAULT_CURRENCY,
  },

  email: {
    driver: env.EMAIL_DRIVER,
    fromAddress: env.EMAIL_FROM_ADDRESS,
    fromName: env.EMAIL_FROM_NAME,
    resendApiKey: env.RESEND_API_KEY,
    sendgridApiKey: env.SENDGRID_API_KEY,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
    },
  },

  sms: {
    driver: env.SMS_DRIVER,
    senderId: env.SMS_SENDER_ID,
    termii: { apiKey: env.TERMII_API_KEY, baseUrl: env.TERMII_BASE_URL },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      fromNumber: env.TWILIO_FROM_NUMBER,
    },
  },

  identity: {
    driver: env.IDENTITY_DRIVER,
    requireNinVerification: env.IDENTITY_REQUIRE_NIN_VERIFICATION,
    dojah: {
      appId: env.DOJAH_APP_ID,
      apiKey: env.DOJAH_API_KEY,
      baseUrl: env.DOJAH_BASE_URL,
    },
    prembly: {
      appId: env.PREMBLY_APP_ID,
      apiKey: env.PREMBLY_API_KEY,
      baseUrl: env.PREMBLY_BASE_URL,
    },
  },

  subscription: {
    trialDurationDays: env.TRIAL_DURATION_DAYS,
    trialPlanCode: env.TRIAL_PLAN_CODE,
    trialMaxUnits: env.TRIAL_MAX_UNITS,
    gracePeriodDays: env.SUBSCRIPTION_GRACE_PERIOD_DAYS,
    dataRetentionDays: env.SUBSCRIPTION_DATA_RETENTION_DAYS,
    allowPublicSignup: env.ALLOW_PUBLIC_ESTATE_SIGNUP,
  },

  visitors: {
    overstayGraceMinutes: env.VISITOR_OVERSTAY_GRACE_MINUTES,
  },

  observability: {
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    sentry: {
      enabled: Boolean(env.SENTRY_DSN),
      dsn: env.SENTRY_DSN,
      publicDsn: env.NEXT_PUBLIC_SENTRY_DSN,
      environment: env.SENTRY_ENVIRONMENT,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      replaysSessionSampleRate: env.SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
      replaysOnErrorSampleRate: env.SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
    },
    newRelic: {
      enabled: env.NEW_RELIC_ENABLED && Boolean(env.NEW_RELIC_LICENSE_KEY),
      licenseKey: env.NEW_RELIC_LICENSE_KEY,
      appName: env.NEW_RELIC_APP_NAME,
      highSecurity: env.NEW_RELIC_HIGH_SECURITY,
    },
    otel: {
      enabled: Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT),
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
    },
  },

  seed: {
    demoPassword: env.SEED_DEMO_PASSWORD,
    estateName: env.SEED_ESTATE_NAME,
    superAdminEmail: env.SEED_SUPER_ADMIN_EMAIL,
  },

  features: {
    threeD: env.FEATURE_3D_ENABLED,
    geolocation: env.FEATURE_GEOLOCATION_ENABLED,
    deviceIntegrations: env.FEATURE_DEVICE_INTEGRATIONS_ENABLED,
  },
} as const;

export type Config = typeof config;
