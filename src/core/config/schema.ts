import { z } from 'zod';
import { isValidDuration } from './duration';

/**
 * Environment schema.
 *
 * Every variable the platform reads is declared here. Anything not in this
 * schema is not configuration — it is a hardcoded constant, and belongs in code
 * where it can be reviewed.
 *
 * Validation runs once at startup and refuses to boot on failure. The
 * alternative — reading `process.env.X` at the call site — fails at 2am inside
 * a payment webhook instead of at deploy time.
 */

const duration = (label: string) =>
  z.string().refine(isValidDuration, {
    message: `${label} must be a duration such as "15m", "30d" or "500ms"`,
  });

/** 32 bytes, hex-encoded. Anything shorter weakens AES-256 and HMAC-SHA256. */
const hexSecret = (label: string) =>
  z
    .string()
    .regex(
      /^[0-9a-fA-F]{64,}$/,
      `${label} must be at least 64 hex characters (32 bytes). Run "pnpm keys:generate" to create one.`,
    );

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65_535);

export const envSchema = z
  .object({
    // --- Application -------------------------------------------------------
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.string().url(),
    APP_NAME: z.string().min(1).default('EstateOS'),
    APP_SUPPORT_EMAIL: z.string().email().default('support@example.com'),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    RUNTIME_TARGET: z.enum(['vercel', 'self-hosted']).default('self-hosted'),

    // --- Database ----------------------------------------------------------
    MONGODB_URI: z.string().min(1),
    MONGODB_DB_NAME: z.string().min(1).default('estate_management'),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(20),
    MONGODB_MIN_POOL_SIZE: z.coerce.number().int().nonnegative().default(2),
    MONGODB_MAX_TIME_MS: z.coerce.number().int().positive().default(10_000),

    // --- Auth & crypto -----------------------------------------------------
    JWT_ACCESS_SECRET: hexSecret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: hexSecret('JWT_REFRESH_SECRET'),
    JWT_ACCESS_TTL: duration('JWT_ACCESS_TTL').default('15m'),
    JWT_REFRESH_TTL: duration('JWT_REFRESH_TTL').default('30d'),
    ENCRYPTION_KEY: hexSecret('ENCRYPTION_KEY'),
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
    ENCRYPTION_BLIND_INDEX_KEY: hexSecret('ENCRYPTION_BLIND_INDEX_KEY'),
    QR_SIGNING_SECRET: hexSecret('QR_SIGNING_SECRET'),
    AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
    AUTH_LOCKOUT_DURATION: duration('AUTH_LOCKOUT_DURATION').default('15m'),
    OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
    OTP_TTL: duration('OTP_TTL').default('10m'),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    TOTP_ISSUER: z.string().min(1).default('EstateOS'),
    ARGON2_MEMORY_COST: z.coerce.number().int().positive().default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

    // --- Cache & rate limiting ---------------------------------------------
    CACHE_DRIVER: z.enum(['memory', 'ioredis', 'upstash']).default('memory'),
    REDIS_URL: z.string().optional(),
    UPSTASH_REDIS_REST_URL: z.string().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.coerce.number().int().positive().default(20),
    GATE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),

    // --- Jobs --------------------------------------------------------------
    QUEUE_DRIVER: z.enum(['inline', 'bullmq', 'cron-route']).default('inline'),
    CRON_SECRET: z.string().optional(),
    VISITOR_OVERSTAY_GRACE_MINUTES: z.coerce.number().int().nonnegative().default(60),

    // --- Storage -----------------------------------------------------------
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanish.default('true'),
    S3_PRESIGN_EXPIRY_SECONDS: z.coerce.number().int().positive().max(3_600).default(300),
    UPLOAD_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),
    UPLOAD_ALLOWED_MIME_TYPES: z
      .string()
      .default('image/jpeg,image/png,image/webp,application/pdf')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: port.optional(),

    // --- Payments ----------------------------------------------------------
    PAYSTACK_SECRET_KEY: z.string().optional(),
    NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: z.string().optional(),
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
    PAYSTACK_CALLBACK_URL: z.string().url().optional(),
    PAYSTACK_PLATFORM_COMMISSION_PERCENT: z.coerce.number().min(0).max(100).default(0),
    DEFAULT_CURRENCY: z.enum(['NGN', 'GHS', 'ZAR', 'KES', 'USD']).default('NGN'),

    // --- Email -------------------------------------------------------------
    EMAIL_DRIVER: z.enum(['console', 'resend', 'sendgrid', 'smtp']).default('console'),
    EMAIL_FROM_ADDRESS: z.string().email().default('no-reply@example.com'),
    EMAIL_FROM_NAME: z.string().default('EstateOS'),
    RESEND_API_KEY: z.string().optional(),
    SENDGRID_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: port.default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: booleanish.default('false'),

    // --- SMS ---------------------------------------------------------------
    SMS_DRIVER: z.enum(['console', 'termii', 'twilio']).default('console'),
    SMS_SENDER_ID: z.string().default('EstateOS'),
    TERMII_API_KEY: z.string().optional(),
    TERMII_BASE_URL: z.string().url().default('https://api.ng.termii.com'),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM_NUMBER: z.string().optional(),

    // --- Identity verification ---------------------------------------------
    IDENTITY_DRIVER: z.enum(['mock', 'dojah', 'prembly']).default('mock'),
    DOJAH_APP_ID: z.string().optional(),
    DOJAH_API_KEY: z.string().optional(),
    DOJAH_BASE_URL: z.string().url().default('https://api.dojah.io'),
    PREMBLY_APP_ID: z.string().optional(),
    PREMBLY_API_KEY: z.string().optional(),
    PREMBLY_BASE_URL: z.string().url().default('https://api.prembly.com'),
    IDENTITY_REQUIRE_NIN_VERIFICATION: booleanish.default('true'),

    // --- SaaS subscription -------------------------------------------------
    TRIAL_DURATION_DAYS: z.coerce.number().int().positive().default(30),
    TRIAL_PLAN_CODE: z.string().default('professional'),
    TRIAL_MAX_UNITS: z.coerce.number().int().positive().default(100),
    SUBSCRIPTION_GRACE_PERIOD_DAYS: z.coerce.number().int().nonnegative().default(14),
    SUBSCRIPTION_DATA_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    ALLOW_PUBLIC_ESTATE_SIGNUP: booleanish.default('true'),

    // --- Observability -----------------------------------------------------
    LOG_LEVEL: z
      .enum(['silent', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info'),
    LOG_PRETTY: booleanish.default('false'),
    SENTRY_DSN: z.string().optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
    SENTRY_ENVIRONMENT: z.string().default('development'),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    SENTRY_REPLAYS_SESSION_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    NEW_RELIC_LICENSE_KEY: z.string().optional(),
    NEW_RELIC_APP_NAME: z.string().default('EstateOS'),
    NEW_RELIC_ENABLED: booleanish.default('false'),
    NEW_RELIC_HIGH_SECURITY: booleanish.default('false'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().default('estate-management-app'),

    // --- Seed --------------------------------------------------------------
    SEED_DEMO_PASSWORD: z.string().default('DemoPass123!'),
    SEED_ESTATE_NAME: z.string().default('Palm Grove Estate'),
    SEED_SUPER_ADMIN_EMAIL: z.string().email().default('superadmin@example.com'),

    // --- Feature flags -----------------------------------------------------
    FEATURE_3D_ENABLED: booleanish.default('true'),
    FEATURE_GEOLOCATION_ENABLED: booleanish.default('false'),
    FEATURE_DEVICE_INTEGRATIONS_ENABLED: booleanish.default('false'),
  })

  // ---------------------------------------------------------------------------
  // Cross-field rules. A driver selected without its credentials is a
  // misconfiguration that would otherwise surface as a runtime crash in the
  // middle of a payment or an OTP send.
  // ---------------------------------------------------------------------------
  .superRefine((env, ctx) => {
    const require = (field: keyof typeof env, when: string) => {
      if (!env[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${String(field)} is required when ${when}.`,
        });
      }
    };

    if (env.CACHE_DRIVER === 'ioredis') require('REDIS_URL', 'CACHE_DRIVER=ioredis');
    if (env.CACHE_DRIVER === 'upstash') {
      require('UPSTASH_REDIS_REST_URL', 'CACHE_DRIVER=upstash');
      require('UPSTASH_REDIS_REST_TOKEN', 'CACHE_DRIVER=upstash');
    }

    if (env.QUEUE_DRIVER === 'bullmq') require('REDIS_URL', 'QUEUE_DRIVER=bullmq');
    // Without CRON_SECRET anyone who finds the URL could trigger a billing run.
    if (env.QUEUE_DRIVER === 'cron-route') require('CRON_SECRET', 'QUEUE_DRIVER=cron-route');

    if (env.STORAGE_DRIVER === 's3') {
      require('S3_BUCKET', 'STORAGE_DRIVER=s3');
      require('S3_ACCESS_KEY_ID', 'STORAGE_DRIVER=s3');
      require('S3_SECRET_ACCESS_KEY', 'STORAGE_DRIVER=s3');
    }

    if (env.EMAIL_DRIVER === 'resend') require('RESEND_API_KEY', 'EMAIL_DRIVER=resend');
    if (env.EMAIL_DRIVER === 'sendgrid') require('SENDGRID_API_KEY', 'EMAIL_DRIVER=sendgrid');
    if (env.EMAIL_DRIVER === 'smtp') require('SMTP_HOST', 'EMAIL_DRIVER=smtp');

    if (env.SMS_DRIVER === 'termii') require('TERMII_API_KEY', 'SMS_DRIVER=termii');
    if (env.SMS_DRIVER === 'twilio') {
      require('TWILIO_ACCOUNT_SID', 'SMS_DRIVER=twilio');
      require('TWILIO_AUTH_TOKEN', 'SMS_DRIVER=twilio');
      require('TWILIO_FROM_NUMBER', 'SMS_DRIVER=twilio');
    }

    if (env.IDENTITY_DRIVER === 'dojah') {
      require('DOJAH_APP_ID', 'IDENTITY_DRIVER=dojah');
      require('DOJAH_API_KEY', 'IDENTITY_DRIVER=dojah');
    }
    if (env.IDENTITY_DRIVER === 'prembly') {
      require('PREMBLY_APP_ID', 'IDENTITY_DRIVER=prembly');
      require('PREMBLY_API_KEY', 'IDENTITY_DRIVER=prembly');
    }

    if (env.NEW_RELIC_ENABLED) require('NEW_RELIC_LICENSE_KEY', 'NEW_RELIC_ENABLED=true');

    // The two JWT keys must differ so that a leaked access key cannot be used
    // to mint long-lived refresh tokens.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET, otherwise a leaked access key can mint long-lived sessions.',
      });
    }

    if (env.MONGODB_MIN_POOL_SIZE > env.MONGODB_MAX_POOL_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGODB_MIN_POOL_SIZE'],
        message: 'MONGODB_MIN_POOL_SIZE cannot exceed MONGODB_MAX_POOL_SIZE.',
      });
    }

    // ---- Production-only guards --------------------------------------------
    // These configurations are fine locally and unacceptable in production.
    if (env.NODE_ENV === 'production') {
      if (!env.APP_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_URL'],
          message: 'APP_URL must use HTTPS in production — session cookies are issued Secure.',
        });
      }
      if (env.IDENTITY_DRIVER === 'mock') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['IDENTITY_DRIVER'],
          message:
            'IDENTITY_DRIVER=mock accepts any NIN and must never run in production. Configure dojah or prembly.',
        });
      }
      if (env.CACHE_DRIVER === 'memory') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CACHE_DRIVER'],
          message:
            'CACHE_DRIVER=memory is per-process, so rate limits would not be shared across instances. Use ioredis or upstash in production.',
        });
      }
      if (env.STORAGE_DRIVER === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STORAGE_DRIVER'],
          message:
            'STORAGE_DRIVER=local writes resident documents to the local filesystem. Use s3 in production.',
        });
      }
      if (env.EMAIL_DRIVER === 'console' || env.SMS_DRIVER === 'console') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [env.EMAIL_DRIVER === 'console' ? 'EMAIL_DRIVER' : 'SMS_DRIVER'],
          message:
            'console drivers discard messages. OTPs and emergency alerts would never be delivered in production.',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;
