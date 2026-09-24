/**
 * Self-serve estate signup.
 *
 * Four properties matter, and each one is a way the feature fails badly rather
 * than merely inconveniently:
 *
 *  - a signup produces a COMPLETE estate — roles, chairman, trial — because a
 *    partial one cannot be repaired through any screen the product has;
 *  - it answers identically for a taken address, because this is an
 *    unauthenticated endpoint and the alternative is an enumeration oracle;
 *  - a failure part-way through leaves NOTHING behind, for the same reason as
 *    the first;
 *  - the estate is inert until the emailed link is redeemed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { TRIAL_DAYS } from '@/core/entitlements';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import { accountTokenRepository, hashOpaqueToken } from '@/modules/auth';
import { EstateModel } from '@/modules/estate';
import { MembershipModel } from '@/modules/membership/schema';
import { notificationService } from '@/modules/notification';
import { RoleModel } from '@/modules/role';
import { UserModel } from '@/modules/user/schema';
import { AuditLogModel } from '@/modules/audit';
import { signupService, SIGNUP_MESSAGE } from './signup.service';
import { slugifyEstateName } from './slug';

setupTestDatabase();

beforeEach(() => setCache(new MemoryCacheAdapter()));
afterEach(() => {
  setCache(undefined);
  vi.restoreAllMocks();
});

let sequence = 0;

function signup(overrides: Partial<Parameters<typeof signupService.start>[0]> = {}) {
  sequence += 1;

  return {
    estateName: `Palm Grove ${sequence}`,
    address: { line1: '1 Palm Avenue', city: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    firstName: 'Bola',
    lastName: 'Adeyemi',
    email: `chair${sequence}@example.com`,
    phone: `+23481000000${String(sequence).padStart(2, '0')}`,
    // Long, mixed case, numeric, and unrelated to the name or the address, so
    // the strength check passes for the reason the product intends rather than
    // by luck.
    password: 'Correct-Horse-Battery-91',
    ...overrides,
  };
}

/** The plaintext token the most recent verification email carried. */
function captureVerificationLink(): { url: () => string } {
  let captured = '';

  vi.spyOn(notificationService, 'sendToAddress').mockImplementation(
    async (input: { templateId: string; data: Record<string, unknown> }) => {
      if (input.templateId === 'estate.signup-verification') {
        captured = String(input.data.verificationUrl);
      }
      return true;
    },
  );

  return { url: () => captured };
}

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

describe('starting a signup', () => {
  it('creates a complete, usable estate', async () => {
    const link = captureVerificationLink();
    const input = signup();

    const result = await signupService.start(input);
    expect(result.message).toBe(SIGNUP_MESSAGE);

    const estate = await EstateModel.findOne({ name: input.estateName }).lean();
    expect(estate).toBeTruthy();

    // The trial: running, at Professional, with no plan recorded — recording
    // one would make the billing run charge for it.
    expect(estate!.status).toBe('trial');
    expect(estate!.planCode ?? null).toBeNull();
    const daysOut = Math.round((estate!.trialEndsAt!.getTime() - Date.now()) / 86_400_000);
    expect(daysOut).toBe(TRIAL_DAYS);

    // The roles. An estate without them has no chairman and no way to appoint
    // one, and the failure would surface later as a permissions mystery.
    const roles = await RoleModel.find({ estateId: estate!._id }).lean();
    expect(roles.length).toBeGreaterThan(1);
    const chairman = roles.find((role) => role.code === 'estate-chairman');
    expect(chairman).toBeTruthy();

    // The chairman, holding that role.
    const membership = await MembershipModel.findOne({ estateId: estate!._id }).lean();
    expect(membership).toBeTruthy();
    expect(membership!.roleIds.map(String)).toEqual([String(chairman!._id)]);
    expect(membership!.category).toBe('estate-staff');

    const user = await UserModel.findById(membership!.userId).lean();
    expect(user!.email).toBe(input.email);
    expect(user!.isPlatformAdmin).toBe(false);

    // The link was sent.
    expect(link.url()).toContain('/signup/verify?token=');
  });

  it('derives the slug server-side rather than taking one from the request', async () => {
    captureVerificationLink();
    const input = signup({ estateName: '  Palm/Grove  Estate!!  ' });

    await signupService.start(input);

    const estate = await EstateModel.findOne({ name: input.estateName.trim() }).lean();
    expect(estate!.slug).toMatch(/^[a-z0-9-]+$/);
    expect(estate!.slug).toContain('palm-grove-estate');
  });

  it('gives a second estate of the same name a different identifier', async () => {
    captureVerificationLink();

    await signupService.start(signup({ estateName: 'Identical Estate' }));
    await signupService.start(signup({ estateName: 'Identical Estate' }));

    const estates = await EstateModel.find({ name: 'Identical Estate' }).lean();
    expect(estates).toHaveLength(2);
    expect(estates[0]!.slug).not.toBe(estates[1]!.slug);
  });

  it('never yields a reserved identifier', () => {
    for (const name of ['api', 'Admin', 'signup', '!!!', 'ok']) {
      expect(slugifyEstateName(name)).toMatch(/^estate-/);
    }
  });
});

describe('an address that is already registered', () => {
  it('is indistinguishable from a fresh one', async () => {
    captureVerificationLink();
    const first = signup();
    await signupService.start(first);

    // A different estate and a different phone, the same address.
    const second = signup({ email: first.email });

    const sent: string[] = [];
    vi.spyOn(notificationService, 'sendToAddress').mockImplementation(
      async (input: { templateId: string }) => {
        sent.push(input.templateId);
        return true;
      },
    );

    const result = await signupService.start(second);

    // Same message, no error, nothing that varies with the outcome.
    expect(result.message).toBe(SIGNUP_MESSAGE);

    // And nothing was created.
    expect(await EstateModel.countDocuments({ name: second.estateName })).toBe(0);

    // The existing holder was told instead, which is how a person who forgot
    // they had signed up gets unstuck without anyone else learning anything.
    expect(sent).toEqual(['account.duplicate-registration']);
  });

  it('answers the same way for a phone number already in use', async () => {
    captureVerificationLink();
    const first = signup();
    await signupService.start(first);

    const second = signup({ phone: first.phone });
    const result = await signupService.start(second);

    expect(result.message).toBe(SIGNUP_MESSAGE);
    expect(await EstateModel.countDocuments({ name: second.estateName })).toBe(0);
  });
});

describe('when the signup fails part way through', () => {
  it('leaves nothing behind', async () => {
    captureVerificationLink();
    const input = signup();

    const before = {
      estates: await EstateModel.countDocuments({}),
      users: await UserModel.countDocuments({}),
      memberships: await MembershipModel.countDocuments({}),
      roles: await RoleModel.countDocuments({}),
    };

    // Fail at the last write inside the transaction. An estate and its roles
    // have already been created by this point, so this is exactly the window
    // that would otherwise leave an estate nobody can administer.
    vi.spyOn(MembershipModel, 'create').mockRejectedValueOnce(new Error('write conflict'));

    await expect(signupService.start(input)).rejects.toThrow();

    expect(await EstateModel.countDocuments({})).toBe(before.estates);
    expect(await UserModel.countDocuments({})).toBe(before.users);
    expect(await MembershipModel.countDocuments({})).toBe(before.memberships);
    expect(await RoleModel.countDocuments({})).toBe(before.roles);

    // In particular, the name is free again — a retry must work.
    expect(await EstateModel.countDocuments({ name: input.estateName })).toBe(0);
  });
});

describe('verification', () => {
  it('is what makes the estate signable-into', async () => {
    const link = captureVerificationLink();
    const input = signup();
    await signupService.start(input);

    const estate = await EstateModel.findOne({ name: input.estateName }).lean();

    // Before: the chairman's membership is pending, which is what login
    // refuses. The estate exists and has no active member at all.
    const pending = await MembershipModel.findOne({ estateId: estate!._id }).lean();
    expect(pending!.status).toBe('pending');
    expect(await MembershipModel.countDocuments({ estateId: estate!._id, status: 'active' })).toBe(
      0,
    );

    const user = await UserModel.findById(pending!.userId).lean();
    expect(user!.emailVerifiedAt ?? null).toBeNull();
    expect(user!.status).toBe('pending');

    const verified = await signupService.verify(tokenFrom(link.url()));
    expect(verified.estateName).toBe(input.estateName);
    expect(verified.estateSlug).toBe(estate!.slug);

    // After: the chairman can sign in and the estate is usable.
    const active = await MembershipModel.findById(pending!._id).lean();
    expect(active!.status).toBe('active');
    expect(active!.approvedAt).toBeTruthy();

    const verifiedUser = await UserModel.findById(pending!.userId).lean();
    expect(verifiedUser!.status).toBe('active');
    expect(verifiedUser!.emailVerifiedAt).toBeTruthy();
  });

  it('spends the link, so a replayed one does nothing', async () => {
    const link = captureVerificationLink();
    await signupService.start(signup());

    const token = tokenFrom(link.url());
    await signupService.verify(token);

    await expect(signupService.verify(token)).rejects.toThrow(/invalid or has expired/i);
  });

  it('refuses an expired link', async () => {
    const link = captureVerificationLink();
    await signupService.start(signup());

    const token = tokenFrom(link.url());
    await accountTokenRepository.updateOne(
      { tokenHash: hashOpaqueToken(token) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    await expect(signupService.verify(token)).rejects.toThrow(/invalid or has expired/i);
  });

  it('refuses a token that was never issued', async () => {
    await expect(signupService.verify('v1.not.a.real.token.at.all')).rejects.toThrow(
      /invalid or has expired/i,
    );
  });

  it('records both halves in the estate’s own audit trail', async () => {
    const link = captureVerificationLink();
    const input = signup();
    await signupService.start(input);
    await signupService.verify(tokenFrom(link.url()));

    const estate = await EstateModel.findOne({ name: input.estateName }).lean();
    const actions = (await AuditLogModel.find({ estateId: estate!._id }).lean()).map(
      (entry) => entry.action,
    );

    expect(actions).toContain('estate.created');
    expect(actions).toContain('estate.signup_started');
    expect(actions).toContain('estate.signup_verified');
  });

  it('does not write the chairman’s address into the trail in the clear', async () => {
    captureVerificationLink();
    const input = signup();
    await signupService.start(input);

    const entry = await AuditLogModel.findOne({ action: 'estate.signup_started' }).lean();
    expect(entry!.metadata!.chairmanEmail).not.toBe(input.email);
    // `maskEmail` keeps the first two characters and the domain, nothing else.
    expect(String(entry!.metadata!.chairmanEmail)).toMatch(/^ch\u2022+@example\.com$/);
  });
});

describe('rate limiting', () => {
  it('throttles repeated attempts on one address', async () => {
    captureVerificationLink();
    const email = `repeat${Date.now()}@example.com`;

    // Three are allowed; the first succeeds and the next two are duplicates.
    for (let attempt = 0; attempt < 3; attempt++) {
      await signupService.start(signup({ email }));
    }

    await expect(signupService.start(signup({ email }))).rejects.toThrow(/too many/i);
  });
});
