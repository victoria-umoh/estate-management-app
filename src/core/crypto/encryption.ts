import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { currentKeyVersion, encryptionKey } from './keys';

/**
 * Authenticated field-level encryption for sensitive identity data — NIN,
 * document numbers, bank details.
 *
 * AES-256-GCM is used rather than CBC so that ciphertext is tamper-evident:
 * decryption fails loudly if a stored value was modified, instead of silently
 * yielding corrupted plaintext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16;

export interface EncryptedField {
  /** Ciphertext, base64. */
  ct: string;
  /** Initialisation vector, base64. Unique per encryption. */
  iv: string;
  /** GCM authentication tag, base64. */
  tag: string;
  /** Key version, so keys can be rotated without re-encrypting everything. */
  v: number;
}

/**
 * Encrypt a value.
 *
 * `context` is bound in as additional authenticated data. It is not secret; it
 * ties the ciphertext to where it lives (for example `resident.nin`), so a
 * stored value cannot be copied into a different field — or a different
 * resident's record — and still decrypt.
 */
export function encryptField(plaintext: string, context?: string): EncryptedField {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);

  if (context) cipher.setAAD(Buffer.from(context, 'utf8'));

  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    v: currentKeyVersion,
  };
}

/**
 * Decrypt a value.
 *
 * @throws if the ciphertext, IV, tag or context does not match — which means
 *         the record was tampered with, moved between fields, or encrypted
 *         under a key this process does not hold.
 */
export function decryptField(field: EncryptedField, context?: string): string {
  const iv = Buffer.from(field.iv, 'base64');
  const tag = Buffer.from(field.tag, 'base64');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted field: unexpected IV or authentication tag length.');
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv);
  decipher.setAuthTag(tag);
  if (context) decipher.setAAD(Buffer.from(context, 'utf8'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(field.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Deliberately opaque: the caller learns the value is unreadable, not which
    // part of the authentication failed.
    throw new Error('Failed to decrypt field: data has been tampered with or the key is wrong.');
  }
}

/** Type guard for values read back from the database. */
export function isEncryptedField(value: unknown): value is EncryptedField {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EncryptedField).ct === 'string' &&
    typeof (value as EncryptedField).iv === 'string' &&
    typeof (value as EncryptedField).tag === 'string' &&
    typeof (value as EncryptedField).v === 'number'
  );
}
