/**
 * Scrubbing for telemetry leaving the platform.
 *
 * Sentry and New Relic receive error payloads that can include request bodies,
 * query strings and local variables. This application handles NIN, home
 * addresses, minors' records and payment references, so anything sent outward
 * is filtered here first — the log redaction in `core/logging` does not cover
 * these vendors' own capture paths.
 */

const SENSITIVE_KEY =
  /(nin|bvn|password|token|secret|otp|cvv|pin|authorization|cookie|apikey|api_key|account_?number|card_?number)/i;

const REDACTED = '[REDACTED]';

/** Recursively redact sensitive keys in an arbitrary structure. */
export function scrubObject<T>(value: T, depth = 0): T {
  // Bound recursion: a cyclic or pathological payload must not hang the process
  // inside an error handler.
  if (depth > 8 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubObject(item, depth + 1)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubObject(item, depth + 1);
  }
  return result as T;
}

/** Strip sensitive query parameters from a URL before it is reported. */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Redact values that look sensitive wherever they appear in free text.
 *
 * Covers the case where a value is embedded in an error message rather than
 * carried in a labelled field.
 */
export function scrubText(text: string): string {
  return (
    text
      // Nigerian NIN: 11 consecutive digits.
      .replace(/\b\d{11}\b/g, REDACTED)
      // Bearer tokens and long opaque secrets.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
      // Credentials embedded in a connection string.
      .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, `$1${REDACTED}@`)
      // Paystack keys.
      .replace(/\b[sp]k_(test|live)_[A-Za-z0-9]+/g, REDACTED)
  );
}
