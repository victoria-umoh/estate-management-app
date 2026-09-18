import { createHash } from 'node:crypto';
import { config } from '@/core/config';

/**
 * Key material, derived on first use rather than at import.
 *
 * Module-level constants would read config as soon as the module loaded, which
 * would make a production build demand the real encryption key just to compile.
 * Secrets belong at runtime.
 */

function decodeKey(hex: string): Buffer {
  // The config schema already guarantees >= 64 hex characters, so this is a
  // decode rather than a validation. Taking the first 32 bytes accepts a longer
  // key without changing the AES-256 / HMAC-SHA256 key size.
  return Buffer.from(hex, 'hex').subarray(0, 32);
}

let encryption: Buffer | undefined;
let blindIndexKeyCache: Buffer | undefined;
let qrKey: Buffer | undefined;

export function getEncryptionKey(): Buffer {
  encryption ??= decodeKey(config.crypto.encryptionKey);
  return encryption;
}

export function getBlindIndexKey(): Buffer {
  blindIndexKeyCache ??= decodeKey(config.crypto.blindIndexKey);
  return blindIndexKeyCache;
}

export function getQrSigningKey(): Buffer {
  qrKey ??= decodeKey(config.crypto.qrSigningSecret);
  return qrKey;
}

export function currentKeyVersion(): number {
  return config.crypto.encryptionKeyVersion;
}

/**
 * Short, non-reversible fingerprint of a key, safe to log.
 *
 * Lets us confirm which key a deployment loaded — and spot an accidental key
 * change — without putting key material in a log line.
 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
