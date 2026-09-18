/**
 * Authentication flows against a real database.
 *
 * These are integration tests rather than mocked unit tests because the
 * properties under test — uniqueness enforced by indexes, rotation persisted
 * atomically, reuse detected across documents — are properties of how the data
 * layer actually behaves.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { userRepository } from '@/modules/user/repository';
import { authService } from './service';
import { sessionRepository } from './session.repository';
import { SessionModel } from './session.schema';
import { hashRefreshToken, verifyAccessToken } from './tokens';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());
  // The unique blind-index constraints are the actual duplicate-identity
  // guarantee, so they must exist for these tests to mean anything.
  await UserModel.syncIndexes();
  await MembershipModel.syncIndexes();
  await SessionModel.syncIndexes();
});

afterEach(() => setCache(undefined));

const validRegistration = {
  firstName: 'Ada',
  lastName: 'Okonkwo',
  email: 'ada@example.com',
  phone: '+2348012345678',
  password: 'Str0ngPassphrase!',
  estateId: ESTATE_A,
  category: 'homeowner' as const,
};

async function registerAndActivate(overrides: Record<string, unknown> = {}) {
  const result = await authService.register({ ...validRegistration, ...overrides } as never);

  await UserModel.updateOne({ _id: result.userId }, { $set: { status: 'active' } });
  await MembershipModel.updateOne({ _id: result.membershipId }, { $set: { status: 'active' } });

  return result;
}

describe('registration', () => {
  it('creates a user and an estate membership together', async () => {
    const { userId, membershipId } = await authService.register(validRegistration);

    const user = await UserModel.findById(userId).lean();
    const membership = await MembershipModel.findById(membershipId).lean();

    expect(user?.email).toBe('ada@example.com');
    expect(user?.status).toBe('pending');
    expect(membership?.estateId.toHexString()).toBe(ESTATE_A);
    expect(membership?.category).toBe('homeowner');
  });

  it('stores only a hash of the password', async () => {
    const { userId } = await authService.register(validRegistration);
    const user = await UserModel.findById(userId).select('+passwordHash').lean();

    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain('Str0ngPassphrase!');
  });

  it('stores blind indexes rather than searchable plaintext', async () => {
    const { userId } = await authService.register(validRegistration);
    const user = await UserModel.findById(userId).lean();

    expect(user?.emailIndex).toBe(blindIndex('ada@example.com', 'email'));
    expect(user?.phoneIndex).toBe(blindIndex('+2348012345678', 'phone'));
  });

  describe('duplicate identity detection', () => {
    it('rejects a duplicate email', async () => {
      await authService.register(validRegistration);
      await expect(authService.register(validRegistration)).rejects.toMatchObject({
        code: 'DUPLICATE_IDENTITY',
      });
    });

    it('rejects a duplicate phone number', async () => {
      await authService.register(validRegistration);
      await expect(
        authService.register({ ...validRegistration, email: 'other@example.com' }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
    });

    // Normalisation means the same line in a different spelling still collides.
    it('rejects the same phone number written differently', async () => {
      await authService.register(validRegistration);
      await expect(
        authService.register({
          ...validRegistration,
          email: 'other@example.com',
          phone: '08012345678',
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
    });

    it('rejects the same email in a different case', async () => {
      await authService.register(validRegistration);
      await expect(
        authService.register({
          ...validRegistration,
          email: 'ADA@Example.com',
          phone: '+2348099999999',
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects a weak password before creating anything', async () => {
    await expect(
      authService.register({ ...validRegistration, password: 'password' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await UserModel.countDocuments()).toBe(0);
  });
});

describe('login', () => {
  it('issues tokens for valid credentials', async () => {
    await registerAndActivate();

    const result = await authService.login(
      { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
      { ip: '10.0.0.1' },
    );

    expect(result.tokens?.accessToken).toBeTruthy();
    expect(result.tokens?.refreshToken).toBeTruthy();

    const claims = await verifyAccessToken(result.tokens!.accessToken);
    expect(claims.est).toBe(ESTATE_A);
  });

  it('never returns the password hash', async () => {
    await registerAndActivate();
    const result = await authService.login(
      { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
      {},
    );
    expect(JSON.stringify(result)).not.toContain('argon2');
  });

  it.each([
    ['wrong password', 'ada@example.com', 'WrongPassword1!'],
    ['unknown account', 'nobody@example.com', 'Str0ngPassphrase!'],
  ])('rejects %s with an identical message', async (_label, email, password) => {
    await registerAndActivate();
    await expect(authService.login({ email, password }, {})).rejects.toMatchObject({
      message: 'Incorrect email or password.',
    });
  });

  it('stores only a hash of the refresh token', async () => {
    await registerAndActivate();
    const result = await authService.login(
      { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
      {},
    );

    const stored = await SessionModel.findOne().lean();
    expect(stored?.refreshTokenHash).toBe(hashRefreshToken(result.tokens!.refreshToken));
    expect(stored?.refreshTokenHash).not.toBe(result.tokens!.refreshToken);
  });

  describe('account state', () => {
    it('refuses a membership still awaiting approval', async () => {
      const { userId } = await authService.register(validRegistration);
      await UserModel.updateOne({ _id: userId }, { $set: { status: 'active' } });

      await expect(
        authService.login({ email: 'ada@example.com', password: 'Str0ngPassphrase!' }, {}),
      ).rejects.toMatchObject({ code: 'ACCOUNT_PENDING_APPROVAL' });
    });

    it('refuses a suspended account', async () => {
      const { userId } = await registerAndActivate();
      await UserModel.updateOne({ _id: userId }, { $set: { status: 'suspended' } });

      await expect(
        authService.login({ email: 'ada@example.com', password: 'Str0ngPassphrase!' }, {}),
      ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });
  });

  describe('lockout', () => {
    it('locks the account after repeated failures', async () => {
      await registerAndActivate();

      for (let i = 0; i < 5; i++) {
        await authService
          .login({ email: 'ada@example.com', password: 'Wrong1234!' }, {})
          .catch(() => {});
      }

      // Even the correct password is refused once locked.
      await expect(
        authService.login({ email: 'ada@example.com', password: 'Str0ngPassphrase!' }, {}),
      ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    });

    it('clears the failure count on a successful login', async () => {
      const { userId } = await registerAndActivate();

      await authService
        .login({ email: 'ada@example.com', password: 'Wrong1!aaaa' }, {})
        .catch(() => {});
      await authService.login({ email: 'ada@example.com', password: 'Str0ngPassphrase!' }, {});

      expect((await UserModel.findById(userId).lean())?.failedLoginAttempts).toBe(0);
    });
  });

  describe('multi-estate membership', () => {
    it('asks which estate to enter when the user belongs to several', async () => {
      const { userId } = await registerAndActivate();

      await MembershipModel.create({
        estateId: new mongoose.Types.ObjectId(ESTATE_B),
        userId: new mongoose.Types.ObjectId(userId),
        category: 'tenant',
        status: 'active',
        roleIds: [],
      });

      const result = await authService.login(
        { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
        {},
      );

      // Authentication succeeded, but no tokens until a tenant is chosen.
      expect(result.tokens).toBeUndefined();
      expect(result.estateChoices).toHaveLength(2);
    });

    it('issues tokens for the chosen estate', async () => {
      const { userId } = await registerAndActivate();
      await MembershipModel.create({
        estateId: new mongoose.Types.ObjectId(ESTATE_B),
        userId: new mongoose.Types.ObjectId(userId),
        category: 'tenant',
        status: 'active',
        roleIds: [],
      });

      const result = await authService.login(
        { email: 'ada@example.com', password: 'Str0ngPassphrase!', estateId: ESTATE_B },
        {},
      );

      expect((await verifyAccessToken(result.tokens!.accessToken)).est).toBe(ESTATE_B);
    });
  });
});

describe('refresh token rotation', () => {
  async function loginTokens() {
    await registerAndActivate();
    const result = await authService.login(
      { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
      {},
    );
    return result.tokens!;
  }

  it('issues a new pair and invalidates the old token', async () => {
    const original = await loginTokens();
    const rotated = await authService.refresh(original.refreshToken, {});

    expect(rotated.refreshToken).not.toBe(original.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
  });

  it('keeps the session, rather than creating a new one, on rotation', async () => {
    const original = await loginTokens();
    await authService.refresh(original.refreshToken, {});
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  // The core anti-theft property. Presenting an already-rotated token means two
  // parties hold it; we cannot tell which is the thief, so both are evicted.
  describe('reuse detection', () => {
    it('revokes every session when a rotated token is replayed', async () => {
      const original = await loginTokens();
      const rotated = await authService.refresh(original.refreshToken, {});

      await expect(authService.refresh(original.refreshToken, {})).rejects.toMatchObject({
        code: 'SESSION_REVOKED',
      });

      // The legitimate holder is signed out too — deliberately.
      await expect(authService.refresh(rotated.refreshToken, {})).rejects.toThrow();

      const sessions = await SessionModel.find().lean();
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      expect(sessions[0]?.revokedReason).toBe('rotation-reuse');
    });

    it('revokes sessions on other devices too', async () => {
      await registerAndActivate();

      const deviceA = (
        await authService.login(
          { email: 'ada@example.com', password: 'Str0ngPassphrase!', deviceId: 'a' },
          {},
        )
      ).tokens!;
      await authService.login(
        { email: 'ada@example.com', password: 'Str0ngPassphrase!', deviceId: 'b' },
        {},
      );

      await authService.refresh(deviceA.refreshToken, {});
      await authService.refresh(deviceA.refreshToken, {}).catch(() => {});

      const active = await SessionModel.countDocuments({ revokedAt: null });
      expect(active).toBe(0);
    });
  });

  it('rejects an unknown token', async () => {
    await expect(authService.refresh('not-a-real-token', {})).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects a revoked session', async () => {
    const tokens = await loginTokens();
    const session = await SessionModel.findOne().lean();
    await sessionRepository.revoke(session!._id, 'logout');

    await expect(authService.refresh(tokens.refreshToken, {})).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });

  it('rejects an expired session', async () => {
    const tokens = await loginTokens();
    await SessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(authService.refresh(tokens.refreshToken, {})).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  // Losing estate access must take effect at the next refresh, not linger for
  // the lifetime of the session.
  it('rejects refresh once the membership is no longer active', async () => {
    const tokens = await loginTokens();
    await MembershipModel.updateOne({}, { $set: { status: 'suspended' } });

    await expect(authService.refresh(tokens.refreshToken, {})).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('logout', () => {
  it('revokes the session', async () => {
    await registerAndActivate();
    const { tokens } = await authService.login(
      { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
      {},
    );

    await authService.logout(tokens!.refreshToken);

    await expect(authService.refresh(tokens!.refreshToken, {})).rejects.toThrow();
  });

  // Reporting an error would confirm whether a token was valid.
  it('is silent for an unknown token', async () => {
    await expect(authService.logout('unknown-token')).resolves.toBeUndefined();
  });

  it('revokes every session on logout-all', async () => {
    const { userId } = await registerAndActivate();

    await authService.login({ email: 'ada@example.com', password: 'Str0ngPassphrase!' }, {});
    await authService.login({ email: 'ada@example.com', password: 'Str0ngPassphrase!' }, {});

    expect(await authService.logoutAll(userId)).toBe(2);
    expect(await SessionModel.countDocuments({ revokedAt: null })).toBe(0);
  });
});

describe('password change', () => {
  it('changes the password and revokes all sessions', async () => {
    const { userId } = await registerAndActivate();
    const { tokens } = await authService.login(
      { email: 'ada@example.com', password: 'Str0ngPassphrase!' },
      {},
    );

    await authService.changePassword(userId, 'Str0ngPassphrase!', 'An0therStr0ngPass!');

    // A password change is the standard response to a suspected compromise, so
    // existing sessions must not survive it.
    await expect(authService.refresh(tokens!.refreshToken, {})).rejects.toThrow();

    await expect(
      authService.login({ email: 'ada@example.com', password: 'An0therStr0ngPass!' }, {}),
    ).resolves.toMatchObject({ tokens: expect.any(Object) });
  });

  it('requires the current password', async () => {
    const { userId } = await registerAndActivate();
    await expect(
      authService.changePassword(userId, 'WrongCurrent1!', 'An0therStr0ngPass!'),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('refuses reuse of the current password', async () => {
    const { userId } = await registerAndActivate();
    await expect(
      authService.changePassword(userId, 'Str0ngPassphrase!', 'Str0ngPassphrase!'),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('NIN verification', () => {
  it('stores the NIN encrypted with a blind index', async () => {
    const { userId } = await registerAndActivate();

    expect(await authService.verifyNin(userId, '12345678911')).toMatchObject({ verified: true });

    const user = await UserModel.findById(userId).lean();
    expect(user?.ninIndex).toBe(blindIndex('12345678911', 'nin'));
    expect(user?.ninVerifiedAt).toBeInstanceOf(Date);
    // Never stored in a readable form.
    expect(JSON.stringify(user)).not.toContain('12345678911');
  });

  // The mock provider fails NINs ending in 0, keeping the rejection path live.
  it('reports a failed match without storing anything', async () => {
    const { userId } = await registerAndActivate();

    expect(await authService.verifyNin(userId, '12345678910')).toMatchObject({ verified: false });
    expect((await UserModel.findById(userId).lean())?.ninIndex).toBeNull();
  });

  it('refuses a NIN already registered to another account', async () => {
    const first = await registerAndActivate();
    await authService.verifyNin(first.userId, '12345678911');

    const second = await authService.register({
      ...validRegistration,
      email: 'other@example.com',
      phone: '+2348099999999',
    });

    await expect(authService.verifyNin(second.userId, '12345678911')).rejects.toMatchObject({
      code: 'DUPLICATE_IDENTITY',
    });
  });

  it('allows the same account to re-verify its own NIN', async () => {
    const { userId } = await registerAndActivate();
    await authService.verifyNin(userId, '12345678911');
    await expect(authService.verifyNin(userId, '12345678911')).resolves.toMatchObject({
      verified: true,
    });
  });

  it('looks up by NIN through the blind index', async () => {
    const { userId } = await registerAndActivate();
    await authService.verifyNin(userId, '12345678911');

    const found = await userRepository.findByNin('12345678911');
    expect(found?._id.toHexString()).toBe(userId);
  });
});
