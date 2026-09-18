import { createHash } from 'node:crypto';
import { config } from '@/core/config';

/**
 * Decode a hex-encoded key from configuration into raw bytes.
 *
 * The config schema already guarantees ≥64 hex characters, so this is a decode
 * rather than a validation. We take the first 32 bytes so a longer key is
 * accepted without changing the AES-256 / HMAC-SHA256 key size.
 */
function decodeKey(hex: string): Buffer {
  return Buffer.from(hex, 'hex').subarray(0, 32);
}

export const encryptionKey = decodeKey(config.crypto.encryptionKey);
export const blindIndexKey = decodeKey(config.crypto.blindIndexKey);
export const qrSigningKey = decodeKey(config.crypto.qrSigningSecret);

export const currentKeyVersion = config.crypto.encryptionKeyVersion;

/**
 * Short, non-reversible fingerprint of a key, safe to log.
 *
 * Lets us confirm which key a deployment loaded — and spot an accidental key
 * change — without ever putting key material in a log line.
 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
