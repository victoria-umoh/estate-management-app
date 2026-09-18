import { createHmac, timingSafeEqual } from 'node:crypto';
import { getBlindIndexKey } from './keys';

/**
 * Blind indexes: deterministic, keyed hashes that make an encrypted field
 * searchable without making it readable.
 *
 * The problem: NIN must be unique across an estate and we must detect duplicate
 * identities — but AES-GCM ciphertext is randomised, so two encryptions of the
 * same NIN differ and cannot be compared or indexed.
 *
 * The solution: store the ciphertext for retrieval, and alongside it an
 * HMAC-SHA256 of the normalised value under a SEPARATE key. Equal inputs give
 * equal indexes, so a unique index enforces "one account per NIN", while the
 * index itself reveals nothing without the key.
 *
 * Why HMAC and not a plain hash: the input spaces here are small and
 * enumerable. There are only 10^11 NINs, so a bare SHA-256 index would be
 * trivially reversible by brute force. The key is what prevents that, and it is
 * why the blind-index key is distinct from the encryption key — compromising
 * one must not compromise the other.
 */

export type BlindIndexKind = 'nin' | 'email' | 'phone' | 'plate' | 'generic';

/**
 * Normalise before hashing, so trivial formatting differences do not defeat
 * duplicate detection. "0801 234 5678" and "+2348012345678" must produce the
 * same index, or the same person registers twice.
 */
export function normalizeForIndex(value: string, kind: BlindIndexKind = 'generic'): string {
  const trimmed = value.trim();

  switch (kind) {
    case 'nin':
      return trimmed.replace(/\D/g, '');

    case 'email':
      return trimmed.toLowerCase();

    case 'phone': {
      const digits = trimmed.replace(/\D/g, '');
      // Reduce Nigerian numbers to a bare national number so the local and
      // international spellings of one line collapse together.
      if (digits.startsWith('234')) return digits.slice(3).replace(/^0+/, '');
      return digits.replace(/^0+/, '');
    }

    case 'plate':
      return trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');

    default:
      return trimmed.toLowerCase();
  }
}

/**
 * Compute the blind index for a value.
 *
 * `kind` is mixed into the HMAC so the same digits indexed as a NIN and as a
 * phone number produce different values, preventing cross-field correlation.
 */
export function blindIndex(value: string, kind: BlindIndexKind = 'generic'): string {
  const normalized = normalizeForIndex(value, kind);

  if (normalized.length === 0) {
    throw new Error(`Cannot compute a blind index for an empty ${kind} value.`);
  }

  return createHmac('sha256', getBlindIndexKey())
    .update(`${kind}:${normalized}`, 'utf8')
    .digest('hex');
}

/** Constant-time comparison of two blind indexes. */
export function blindIndexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
