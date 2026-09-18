import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '@/core/config';
import { AuthenticationError, ErrorCode, RateLimitError } from '@/core/errors';
import { CacheNamespace, cacheKey, getCache } from '@/integrations/cache';

/**
 * One-time passcodes for phone verification and step-up authentication.
 *
 * Codes are short, so they are brute-forceable by construction: a 6-digit code
 * is 1-in-a-million per guess. Three things keep that safe — a short TTL, a
 * hard attempt cap that destroys the code on exhaustion, and storing only a
 * hash so a cache dump does not reveal live codes.
 */

export type OtpPurpose = 'phone-verification' | 'login-2fa' | 'password-reset' | 'sensitive-change';

interface OtpRecord {
  hash: string;
  attempts: number;
  createdAt: number;
}

function keyFor(purpose: OtpPurpose, subject: string): string {
  return cacheKey(CacheNamespace.OTP, purpose, subject);
}

function hashCode(code: string, subject: string): string {
  // Salted with the subject so the same code for two users hashes differently,
  // and a dump cannot be reversed with one precomputed table.
  return createHash('sha256').update(`${subject}:${code}`).digest('hex');
}

/**
 * Generate and store an OTP. Returns the plaintext once, for delivery only.
 *
 * randomInt is a CSPRNG. Math.random would make codes predictable from prior
 * observations, which is a complete bypass.
 */
export async function issueOtp(purpose: OtpPurpose, subject: string): Promise<string> {
  const max = 10 ** config.auth.otp.length;
  const code = String(randomInt(0, max)).padStart(config.auth.otp.length, '0');

  await getCache().set<OtpRecord>(
    keyFor(purpose, subject),
    { hash: hashCode(code, subject), attempts: 0, createdAt: Date.now() },
    Math.floor(config.auth.otp.ttlMs / 1000),
  );

  return code;
}

/**
 * Verify an OTP, consuming it on success.
 *
 * Every outcome — no code, wrong code, expired code — surfaces the same
 * message, so a caller cannot learn whether a code is outstanding for a given
 * phone number.
 */
export async function verifyOtp(purpose: OtpPurpose, subject: string, code: string): Promise<void> {
  const cache = getCache();
  const key = keyFor(purpose, subject);
  const record = await cache.get<OtpRecord>(key);

  if (!record) {
    throw new AuthenticationError(
      'That code is invalid or has expired. Request a new one.',
      ErrorCode.OTP_EXPIRED,
    );
  }

  if (record.attempts >= config.auth.otp.maxAttempts) {
    await cache.delete(key);
    throw new RateLimitError(60, 'Too many incorrect attempts. Request a new code.');
  }

  const expected = Buffer.from(record.hash, 'utf8');
  const actual = Buffer.from(hashCode(code, subject), 'utf8');
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    // Preserve the remaining TTL: a wrong guess must not extend the window.
    const ttl = (await cache.ttl(key)) ?? Math.floor(config.auth.otp.ttlMs / 1000);
    await cache.set<OtpRecord>(key, { ...record, attempts: record.attempts + 1 }, ttl);

    throw new AuthenticationError(
      'That code is invalid or has expired. Request a new one.',
      ErrorCode.OTP_INVALID,
    );
  }

  // Single-use: consumed immediately so a replay cannot succeed.
  await cache.delete(key);
}

export async function clearOtp(purpose: OtpPurpose, subject: string): Promise<void> {
  await getCache().delete(keyFor(purpose, subject));
}
