/**
 * Fields that must never appear in a log line.
 *
 * Logs are shipped to Sentry, New Relic and whatever aggregator a deployment
 * uses, and they are retained far longer than a request. Anything listed here
 * is replaced with `[REDACTED]` by pino before serialisation.
 *
 * Paths use pino's syntax. `*` matches one level; `[*]` matches array elements.
 * When adding a sensitive field to a model, add it here in the same change.
 */
export const REDACT_PATHS = [
  // Credentials and secrets
  'password',
  '*.password',
  '*.*.password',
  'passwordHash',
  '*.passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'setCookie',

  // Request plumbing that carries the above
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-paystack-signature"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',

  // Identity — the data this platform exists to protect
  'nin',
  '*.nin',
  '*.*.nin',
  'ninPlain',
  'bvn',
  '*.bvn',
  'otp',
  '*.otp',
  'otpCode',
  'totpSecret',
  '*.totpSecret',
  'twoFactorSecret',

  // Financial
  'cardNumber',
  '*.cardNumber',
  'cvv',
  '*.cvv',
  'pin',
  '*.pin',
  'accountNumber',
  '*.accountNumber',

  // Crypto envelopes — logging ciphertext is pointless and invites correlation
  'ct',
  '*.ct',
  'encrypted',
  '*.encrypted',
] as const;

export const REDACT_PLACEHOLDER = '[REDACTED]';
