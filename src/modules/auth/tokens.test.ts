import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
} from './tokens';

const claims = {
  userId: '507f1f77bcf86cd799439011',
  estateId: '507f1f77bcf86cd799439012',
  sessionId: '507f1f77bcf86cd799439013',
  roles: ['resident'],
  permissions: ['visitor.create'],
  isPlatformAdmin: false,
};

describe('access tokens', () => {
  /**
   * The whole security model rests on these being short-lived.
   *
   * `setExpirationTime` takes a numeric argument as epoch **seconds**; it was
   * being given milliseconds, so every token expired in the year 58699 and
   * `JWT_ACCESS_TTL` did nothing. Nothing caught it because every other test
   * only asked whether a token verified — which a permanent one does, happily.
   *
   * The context resolver deliberately performs no database lookup on the
   * strength of this bound, so a token that never expires is also one that
   * cannot be revoked.
   */
  it('expires within the configured lifetime', async () => {
    const token = await issueAccessToken(claims);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
    };

    const lifetimeSeconds = payload.exp - payload.iat;

    expect(lifetimeSeconds).toBeGreaterThan(0);
    // Generous upper bound rather than an exact match, so the test survives a
    // deliberate TTL change while still failing on a unit mix-up of any size.
    expect(lifetimeSeconds).toBeLessThanOrEqual(24 * 60 * 60);

    // And `exp` is a plausible epoch-second value, not a millisecond one.
    expect(payload.exp).toBeLessThan(4_000_000_000);
  });

  it('round-trips claims', async () => {
    const verified = await verifyAccessToken(await issueAccessToken(claims));

    expect(verified.sub).toBe(claims.userId);
    expect(verified.est).toBe(claims.estateId);
    expect(verified.sid).toBe(claims.sessionId);
    expect(verified.perms).toEqual(['visitor.create']);
  });

  it('omits the admin flag for ordinary users', async () => {
    expect((await verifyAccessToken(await issueAccessToken(claims))).adm).toBeUndefined();
    expect(
      (await verifyAccessToken(await issueAccessToken({ ...claims, isPlatformAdmin: true }))).adm,
    ).toBe(true);
  });

  it('rejects a tampered token', async () => {
    const token = await issueAccessToken(claims);
    const [header, payload, signature] = token.split('.') as [string, string, string];

    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.perms = ['*'];
    const reencoded = Buffer.from(JSON.stringify(forged)).toString('base64url');

    await expect(verifyAccessToken(`${header}.${reencoded}.${signature}`)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it.each([
    ['empty', ''],
    ['not a jwt', 'nonsense'],
    ['wrong shape', 'a.b'],
  ])('rejects a %s token', async (_label, token) => {
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  // The client needs to tell "refresh me" from "log in again".
  it('distinguishes expiry from invalidity', async () => {
    await expect(verifyAccessToken('a.b.c')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});

describe('refresh tokens', () => {
  // Not a JWT: opaque random material, so a leaked signing key cannot be used
  // to mint long-lived sessions.
  it('generates high-entropy opaque tokens', () => {
    const { token } = generateRefreshToken();
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(token.split('.')).toHaveLength(1);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateRefreshToken().token));
    expect(tokens.size).toBe(200);
  });

  // Only the hash is stored, so a database dump yields no usable tokens.
  it('hashes deterministically and irreversibly', () => {
    const { token, hash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token.slice(0, 16));
  });

  it('produces different hashes for different tokens', () => {
    expect(generateRefreshToken().hash).not.toBe(generateRefreshToken().hash);
  });
});
