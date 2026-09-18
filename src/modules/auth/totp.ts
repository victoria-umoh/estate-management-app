import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticator } from 'otplib';
import { config } from '@/core/config';
import { decryptField, encryptField, type EncryptedField } from '@/core/crypto';

/**
 * Time-based two-factor authentication.
 *
 * The seed is encrypted at rest: anyone holding it can generate valid codes
 * indefinitely, which makes it equivalent to a permanent password.
 */

// One step of tolerance either side, to absorb clock drift on the user's phone.
authenticator.options = { window: 1 };

export interface TotpEnrollment {
  secret: EncryptedField;
  /** Shown once during setup, then never again. */
  otpauthUrl: string;
  plainSecret: string;
}

export function createTotpEnrollment(accountLabel: string): TotpEnrollment {
  const plainSecret = authenticator.generateSecret();

  return {
    secret: encryptField(plainSecret, 'user:totp'),
    otpauthUrl: authenticator.keyuri(accountLabel, config.auth.totpIssuer, plainSecret),
    plainSecret,
  };
}

export function verifyTotp(encryptedSecret: EncryptedField, token: string): boolean {
  try {
    return authenticator.verify({
      token: token.replace(/\s/g, ''),
      secret: decryptField(encryptedSecret, 'user:totp'),
    });
  } catch {
    return false;
  }
}

/**
 * Recovery codes, for a lost authenticator device.
 *
 * Stored hashed — they are password-equivalent — and returned in plaintext only
 * once, at generation.
 */
export function generateBackupCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: count }, () =>
    randomBytes(5)
      .toString('hex')
      .toUpperCase()
      .match(/.{1,5}/g)!
      .join('-'),
  );

  return { plain, hashed: plain.map(hashBackupCode) };
}

function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

/**
 * Consume a backup code.
 *
 * Returns the remaining codes so the caller can persist the removal — a backup
 * code must work exactly once.
 */
export function consumeBackupCode(
  storedHashes: string[],
  submitted: string,
): { matched: boolean; remaining: string[] } {
  const candidate = Buffer.from(hashBackupCode(submitted), 'utf8');

  for (const stored of storedHashes) {
    const storedBuffer = Buffer.from(stored, 'utf8');
    if (storedBuffer.length === candidate.length && timingSafeEqual(storedBuffer, candidate)) {
      return { matched: true, remaining: storedHashes.filter((h) => h !== stored) };
    }
  }

  return { matched: false, remaining: storedHashes };
}
