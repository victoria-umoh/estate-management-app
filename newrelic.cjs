/**
 * New Relic agent configuration.
 *
 * Loaded automatically by the agent when it is required. The agent itself only
 * loads when NEW_RELIC_ENABLED=true and a licence key is present — see
 * src/instrumentation.ts.
 *
 * This file is CommonJS because the agent reads it before the ESM loader is
 * active.
 */
'use strict';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'PrimeEstate'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  agent_enabled: process.env.NEW_RELIC_ENABLED === 'true',

  /**
   * High-security mode strips request parameters and raises redaction.
   * Recommended ON in production: request bodies here carry NIN, phone numbers
   * and payment references that must not leave the platform in telemetry.
   */
  high_security: process.env.NEW_RELIC_HIGH_SECURITY === 'true',

  logging: {
    level: process.env.NEW_RELIC_LOG_LEVEL || 'warn',
    // Emit to stdout so logs stay in one stream for the platform collector.
    filepath: 'stdout',
  },

  distributed_tracing: {
    enabled: process.env.NEW_RELIC_DISTRIBUTED_TRACING_ENABLED !== 'false',
  },

  application_logging: {
    enabled: process.env.NEW_RELIC_APPLICATION_LOGGING_ENABLED !== 'false',
    forwarding: {
      enabled: process.env.NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED !== 'false',
      max_samples_stored: 10000,
    },
    local_decorating: { enabled: false },
  },

  /**
   * Attribute filtering. These are belt-and-braces alongside high_security:
   * even with parameter capture on, these keys never reach New Relic.
   */
  attributes: {
    exclude: [
      'request.headers.cookie',
      'request.headers.authorization',
      'request.headers.x-api-key',
      'request.headers.x-paystack-signature',
      'request.parameters.nin',
      'request.parameters.password',
      'request.parameters.otp',
      'request.parameters.token',
      'response.headers.set-cookie',
    ],
  },

  transaction_tracer: {
    enabled: true,
    // Record a trace for anything slower than 4x the Apdex target.
    transaction_threshold: 'apdex_f',
    record_sql: 'obfuscated',
  },

  error_collector: {
    enabled: true,
    // Expected client errors are not faults; recording them would drown the
    // genuine ones.
    ignore_status_codes: [400, 401, 402, 403, 404, 409, 422, 429],
  },

  slow_sql: { enabled: true, max_samples: 10 },
};
