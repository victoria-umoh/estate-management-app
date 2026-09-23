import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '@/core/config';
import { AuthenticationError, ErrorCode } from '@/core/errors';

/**
 * Access and refresh tokens.
 *
 * The access token is a signed JWT carrying just enough to authorise a request
 * without a database read. It is short-lived because it cannot be revoked
 * individually — revocation happens at the session level, and the short TTL
 * bounds how long a stolen token stays useful.
 *
 * The refresh token is deliberately NOT a JWT. It is opaque random material,
 * stored only as a hash, so a database dump does not yield usable tokens. Every
 * use rotates it, and presenting a rotated token is treated as theft.
 */

// Derived on first use, so importing this module does not demand secrets at
// build time.
let accessKeyCache: Uint8Array | undefined;

function accessKey(): Uint8Array {
  accessKeyCache ??= new TextEncoder().encode(config.auth.accessSecret);
  return accessKeyCache;
}

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  /** Active estate for this session. */
  est: string;
  /** Session id, so a token can be tied back to a revocable session. */
  sid: string;
  roles: string[];
  perms: string[];
  adm?: boolean;
}

export async function issueAccessToken(claims: {
  userId: string;
  estateId: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  isPlatformAdmin: boolean;
}): Promise<string> {
  return new SignJWT({
    est: claims.estateId,
    sid: claims.sessionId,
    roles: claims.roles,
    perms: claims.permissions,
    ...(claims.isPlatformAdmin ? { adm: true } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setIssuer(config.app.url)
    .setAudience(config.app.url)
    .setExpirationTime(Date.now() + config.auth.accessTtlMs)
    .sign(accessKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey(), {
      issuer: config.app.url,
      audience: config.app.url,
      algorithms: ['HS256'],
    });
    return payload as AccessTokenClaims;
  } catch (error) {
    const expired =
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'ERR_JWT_EXPIRED';

    // Distinguishing expiry from invalidity is safe and useful: the client
    // needs to know whether to refresh or to send the user back to login.
    throw new AuthenticationError(
      expired ? 'Your session has expired.' : 'Invalid authentication token.',
      expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
    );
  }
}

/**
 * Generate opaque credential material.
 *
 * Returns the plaintext once — to be sent to the holder and never stored — plus
 * the hash that is persisted. 32 bytes of CSPRNG output is 256 bits of entropy,
 * which is not guessable at any rate an attacker can sustain, so these need no
 * attempt counter of their own the way a six-digit OTP does.
 */
export function generateOpaqueToken(bytes = 32): { token: string; hash: string } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a refresh token.
 *
 * Longer than the default because it is presented on every request for the life
 * of a session rather than once.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  return generateOpaqueToken(48);
}

export const hashRefreshToken = hashOpaqueToken;
