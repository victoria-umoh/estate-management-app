import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { qrSigningKey } from './keys';

/**
 * Signed, opaque tokens for QR credentials: resident IDs, vehicle tags,
 * visitor passes and exit passes.
 *
 * Design constraints from the gate:
 *
 *  - OFFLINE-VERIFIABLE SHAPE. The signature proves the token was issued by us
 *    before any database lookup, so a forged or corrupted scan is rejected
 *    immediately rather than costing a query.
 *  - OPAQUE. The payload carries an ID and an expiry, never a name, house
 *    number or NIN. A photographed QR must not leak who it belongs to.
 *  - EXPIRING AND REVOCABLE. `exp` bounds a stolen token's lifetime; `jti`
 *    gives the credential store a key to revoke, which is what makes a
 *    screenshot of yesterday's pass useless.
 *
 * Format: `v1.<payload-base64url>.<signature-base64url>`
 */

const VERSION = 'v1';

export type TokenSubject = 'resident' | 'vehicle' | 'visitor' | 'exit-pass' | 'temporary-pass';

export interface TokenPayload {
  /** What kind of credential this is. */
  sub: TokenSubject;
  /** Opaque credential id — the lookup key, not the resident's id. */
  cid: string;
  /** Estate scope, so a token from one estate cannot verify at another's gate. */
  est: string;
  /** Unique token id, for revocation. */
  jti: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. */
  exp: number;
}

export interface VerifiedToken {
  valid: boolean;
  payload?: TokenPayload;
  reason?: 'malformed' | 'bad-signature' | 'expired' | 'wrong-version';
}

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payloadB64: string): string {
  return b64url(createHmac('sha256', qrSigningKey).update(`${VERSION}.${payloadB64}`).digest());
}

/** Issue a signed credential token. */
export function issueToken(input: {
  sub: TokenSubject;
  cid: string;
  est: string;
  ttlSeconds: number;
}): { token: string; payload: TokenPayload } {
  const now = Math.floor(Date.now() / 1000);

  const payload: TokenPayload = {
    sub: input.sub,
    cid: input.cid,
    est: input.est,
    jti: randomBytes(12).toString('base64url'),
    iat: now,
    exp: now + input.ttlSeconds,
  };

  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));

  return { token: `${VERSION}.${payloadB64}.${sign(payloadB64)}`, payload };
}

/**
 * Verify a scanned token.
 *
 * Returns a result rather than throwing: at the gate, an invalid scan is an
 * ordinary outcome that must be shown and logged, not an exception.
 */
export function verifyToken(token: string, now = Date.now()): VerifiedToken {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  const [version, payloadB64, signature] = parts as [string, string, string];
  if (version !== VERSION) return { valid: false, reason: 'wrong-version' };

  // Signature is checked BEFORE the payload is parsed, so untrusted input never
  // reaches JSON.parse.
  const expected = sign(payloadB64);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad-signature' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (typeof payload?.exp !== 'number' || typeof payload?.cid !== 'string') {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.exp * 1000 <= now) {
    // The payload is returned so the gate can show "expired pass for visit X"
    // and log the attempt, rather than a bare failure.
    return { valid: false, reason: 'expired', payload };
  }

  return { valid: true, payload };
}

/**
 * Hash a token for storage and cache lookup.
 *
 * The credential store is keyed by this hash rather than the token itself, so a
 * database or cache dump does not hand an attacker a set of working passes.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
