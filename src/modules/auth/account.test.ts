/**
 * The flows that arrive by email.
 *
 * What is under test is mostly what these endpoints DO NOT do: they do not let
 * a token work twice, they do not let an expired one work at all, they do not
 * say whether an address is registered, and they do not leave an attacker's
 * session alive after the victim has reset their password. Each of those is a
 * property of the implementation rather than of the wiring, so these run
 * against a real database with real token documents.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  setEmailProvider,
  setSmsProvider,
} from '@/integrations/notifications';
import { InlineJobQueue, setQueue } from '@/integrations/queue';
import { registerNotificationJobs, resetNotificationJobs } from '@/modules/notification';
import { MembershipModel } from '@/modules/membership/schema';
import { PropertyModel } from '@/modules/property';
import { UserModel } from '@/modules/user/schema';
import type { RequestContext } from '@/core/tenancy';
import { PERMISSIONS } from '@/core/rbac';
import { accountService } from './account.service';
import { AccountTokenModel } from './account-token.schema';
import { authService } from './service';
import { sessionRepository } from './session.repository';
import { SessionModel } from './session.schema';
import { hashOpaqueToken } from './tokens';

setupTestDatabase();

const ESTATE = new mongoose.Types.ObjectId().toHexString();

let email: ConsoleEmailProvider;

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());

  email = new ConsoleEmailProvider();
  setEmailProvider(email);
  setSmsProvider(new ConsoleSmsProvider());

  // Inline, so an enqueued message has been "sent" by the time the assertion
  // runs. The console provider records what it was asked to send, which is what
  // makes "did the resident actually get told" answerable rather than merely
  // "did send() avoid throwing".
  resetNotificationJobs();
  setQueue(new InlineJobQueue());
  await registerNotificationJobs();

  await UserModel.syncIndexes();
  await MembershipModel.syncIndexes();
  await SessionModel.syncIndexes();
  await AccountTokenModel.syncIndexes();
});

afterEach(() => {
  setCache(undefined);
  setEmailProvider(undefined);
  setSmsProvider(undefined);
  setQueue(undefined);
  resetNotificationJobs();
});

const registration = {
  firstName: 'Ada',
  lastName: 'Okonkwo',
  email: 'ada@example.com',
  phone: '+2348012345678',
  password: 'Str0ngPassphrase!',
  estateId: ESTATE,
  category: 'homeowner' as const,
};

/** The token out of the most recent message containing the given path. */
function linkToken(path: string): string {
  const message = [...email.sent].reverse().find((sent) => sent.text.includes(path));
  if (!message) throw new Error(`No email sent containing ${path}`);

  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error(`No token in the ${path} email`);
  return match[1];
}

async function expire(tokenHash: string): Promise<void> {
  await AccountTokenModel.updateOne(
    { tokenHash },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
}

// -----------------------------------------------------------------------------
// Email verification
// -----------------------------------------------------------------------------

describe('email verification', () => {
  it('emails a verification link when an account is registered', async () => {
    await authService.register(registration);

    const sent = email.sent.at(-1)!;
    expect(sent.to).toBe('ada@example.com');
    expect(sent.subject).toBe('Confirm your email address');
    expect(sent.text).toContain('/verify-email?token=');
  });

  it('stores the token only as a hash', async () => {
    await authService.register(registration);
    const token = linkToken('/verify-email');

    const stored = await AccountTokenModel.findOne({ purpose: 'email-verification' }).lean();

    expect(stored).not.toBeNull();
    expect(stored!.tokenHash).toBe(hashOpaqueToken(token));
    // The plaintext appears nowhere in the document, so a dump of this
    // collection yields nothing presentable.
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('verifies the address and activates the account', async () => {
    const { userId } = await authService.register(registration);

    await accountService.verifyEmail(linkToken('/verify-email'));

    const user = await UserModel.findById(userId).lean();
    expect(user!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user!.status).toBe('active');
  });

  it('refuses a token that has already been used', async () => {
    await authService.register(registration);
    const token = linkToken('/verify-email');

    await accountService.verifyEmail(token);

    await expect(accountService.verifyEmail(token)).rejects.toThrow(/invalid or has expired/i);
  });

  it('lets exactly one of two concurrent redemptions win', async () => {
    await authService.register(registration);
    const token = linkToken('/verify-email');

    // The consume is a single conditional update, so the loser of the race sees
    // no matching document rather than a second success.
    const outcomes = await Promise.allSettled([
      accountService.verifyEmail(token),
      accountService.verifyEmail(token),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    await authService.register(registration);
    const token = linkToken('/verify-email');
    await expire(hashOpaqueToken(token));

    await expect(accountService.verifyEmail(token)).rejects.toThrow(/invalid or has expired/i);
  });

  it('retires the previous link when a new one is issued', async () => {
    await authService.register(registration);
    const first = linkToken('/verify-email');

    await accountService.resendEmailVerification('ada@example.com');
    const second = linkToken('/verify-email');

    expect(second).not.toBe(first);
    await expect(accountService.verifyEmail(first)).rejects.toThrow();
    await expect(accountService.verifyEmail(second)).resolves.toMatchObject({ verified: true });
  });

  it('says the same thing for an unknown address as for a known one', async () => {
    await authService.register(registration);
    email.clear();

    await expect(
      accountService.resendEmailVerification('nobody@example.com'),
    ).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(0);

    await expect(
      accountService.resendEmailVerification('ada@example.com'),
    ).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Password reset
// -----------------------------------------------------------------------------

describe('password reset', () => {
  async function registeredAndActive() {
    const result = await authService.register(registration);
    await UserModel.updateOne({ _id: result.userId }, { $set: { status: 'active' } });
    await MembershipModel.updateOne({ _id: result.membershipId }, { $set: { status: 'active' } });
    email.clear();
    return result;
  }

  it('emails a reset link', async () => {
    await registeredAndActive();

    await accountService.requestPasswordReset('ada@example.com');

    const sent = email.sent.at(-1)!;
    expect(sent.to).toBe('ada@example.com');
    expect(sent.subject).toBe('Reset your password');
    expect(sent.text).toContain('/reset-password?token=');
  });

  describe('account enumeration', () => {
    it('resolves identically for an unregistered address', async () => {
      await registeredAndActive();

      await expect(
        accountService.requestPasswordReset('ghost@example.com'),
      ).resolves.toBeUndefined();
      await expect(accountService.requestPasswordReset('ada@example.com')).resolves.toBeUndefined();
    });

    it('sends nothing for an unregistered address', async () => {
      await accountService.requestPasswordReset('ghost@example.com');
      expect(email.sent).toHaveLength(0);
    });

    it('takes comparable time either way', async () => {
      await registeredAndActive();

      const timed = async (address: string) => {
        const startedAt = Date.now();
        await accountService.requestPasswordReset(address);
        return Date.now() - startedAt;
      };

      const unknown = await timed('ghost@example.com');
      const known = await timed('ada@example.com');

      // Both are padded to the same floor, so the gap is scheduler noise rather
      // than the cost of the work that only the real account does. A generous
      // bound: the point is that it is not the hundreds of milliseconds a user
      // lookup plus a token write plus a queue push would otherwise show.
      expect(Math.abs(known - unknown)).toBeLessThan(120);
    });
  });

  it('changes the password and consumes the token', async () => {
    await registeredAndActive();
    await accountService.requestPasswordReset('ada@example.com');
    const token = linkToken('/reset-password');

    await accountService.resetPassword(token, 'An0therStr0ngOne!');

    await expect(accountService.resetPassword(token, 'Y3tAnotherOne!!')).rejects.toThrow(
      /invalid or has already been used/i,
    );

    // The new password works and the old one does not.
    await expect(
      authService.login({ email: 'ada@example.com', password: 'An0therStr0ngOne!' }, {}),
    ).resolves.toMatchObject({ tokens: expect.anything() });

    await expect(
      authService.login({ email: 'ada@example.com', password: registration.password }, {}),
    ).rejects.toThrow(/incorrect email or password/i);
  });

  it('refuses an expired reset link', async () => {
    await registeredAndActive();
    await accountService.requestPasswordReset('ada@example.com');
    const token = linkToken('/reset-password');
    await expire(hashOpaqueToken(token));

    await expect(accountService.resetPassword(token, 'An0therStr0ngOne!')).rejects.toThrow(
      /invalid or has already been used/i,
    );
  });

  it('revokes every existing session', async () => {
    const { userId } = await registeredAndActive();

    // Two devices signed in — the resident's, and, as far as we can tell, an
    // attacker's. Both must fall.
    await authService.login({ email: 'ada@example.com', password: registration.password }, {});
    await authService.login({ email: 'ada@example.com', password: registration.password }, {});

    expect(await sessionRepository.listActiveForUser(userId)).toHaveLength(2);

    await accountService.requestPasswordReset('ada@example.com');
    const { sessionsRevoked } = await accountService.resetPassword(
      linkToken('/reset-password'),
      'An0therStr0ngOne!',
    );

    expect(sessionsRevoked).toBe(2);
    expect(await sessionRepository.listActiveForUser(userId)).toHaveLength(0);

    const revoked = await SessionModel.find({ userId }).lean();
    expect(revoked.every((session) => session.revokedReason === 'password-changed')).toBe(true);
  });

  it('refuses a weak new password', async () => {
    await registeredAndActive();
    await accountService.requestPasswordReset('ada@example.com');

    await expect(
      accountService.resetPassword(linkToken('/reset-password'), 'password123'),
    ).rejects.toThrow();
  });

  it('rate limits per address, whether or not it is registered', async () => {
    // Three are allowed in the window; the fourth is refused. Keyed on the
    // submitted address, so this is the same for a stranger — which is what
    // stops the 429 itself from leaking existence.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await accountService.requestPasswordReset('ghost@example.com');
    }

    await expect(accountService.requestPasswordReset('ghost@example.com')).rejects.toThrow(
      /too many/i,
    );
  });
});

// -----------------------------------------------------------------------------
// Invitations
// -----------------------------------------------------------------------------

describe('invitations', () => {
  function inviter(permissions: string[] = ['*']): RequestContext {
    return {
      userId: new mongoose.Types.ObjectId().toHexString(),
      estateId: ESTATE,
      roles: ['landlord'],
      permissions: new Set(permissions),
      correlationId: 'corr',
      isPlatformAdmin: false,
    };
  }

  const accept = {
    firstName: 'Chidi',
    lastName: 'Eze',
    phone: '+2348098765432',
    password: 'Inv1tedStr0ng!',
  };

  it('emails the invitee a bounded, single-use link', async () => {
    const { expiresAt } = await accountService.inviteResident(inviter(), {
      email: 'chidi@example.com',
      category: 'tenant',
    });

    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThan(Date.now() + 8 * 86_400_000);

    const sent = email.sent.at(-1)!;
    expect(sent.to).toBe('chidi@example.com');
    expect(sent.text).toContain('/accept-invitation?token=');
  });

  it('refuses a caller without resident.create', async () => {
    await expect(
      accountService.inviteResident(inviter([PERMISSIONS.RESIDENT_VIEW]), {
        email: 'chidi@example.com',
        category: 'tenant',
      }),
    ).rejects.toThrow();
  });

  it('creates the account and the membership on acceptance', async () => {
    const property = await PropertyModel.create({
      estateId: ESTATE,
      unitNumber: '12B',
      street: 'Acacia Close',
      type: 'duplex',
      occupancyStatus: 'vacant',
      currentOccupantCount: 0,
    });

    await accountService.inviteResident(inviter(), {
      email: 'chidi@example.com',
      category: 'tenant',
      propertyId: property._id.toHexString(),
    });

    const result = await accountService.acceptInvitation(linkToken('/accept-invitation'), {
      token: 'ignored',
      ...accept,
    });

    const user = await UserModel.findById(result.userId).lean();
    const membership = await MembershipModel.findById(result.membershipId).lean();

    // The address comes from the token, not the request body, and reaching the
    // link is itself proof of the inbox.
    expect(user!.email).toBe('chidi@example.com');
    expect(user!.emailVerifiedAt).toBeInstanceOf(Date);

    expect(membership!.estateId.toHexString()).toBe(ESTATE);
    expect(membership!.category).toBe('tenant');
    expect(membership!.propertyId!.toHexString()).toBe(property._id.toHexString());
    // An invitation gets you in the door, not past the administrator.
    expect(membership!.status).toBe('awaiting-approval');
  });

  it('cannot be accepted twice', async () => {
    await accountService.inviteResident(inviter(), {
      email: 'chidi@example.com',
      category: 'tenant',
    });
    const token = linkToken('/accept-invitation');

    await accountService.acceptInvitation(token, { token, ...accept });

    await expect(
      accountService.acceptInvitation(token, {
        token,
        ...accept,
        phone: '+2348011112222',
      }),
    ).rejects.toThrow(/invalid, has expired, or has already been used/i);
  });

  it('refuses an expired invitation', async () => {
    await accountService.inviteResident(inviter(), {
      email: 'chidi@example.com',
      category: 'tenant',
    });
    const token = linkToken('/accept-invitation');
    await expire(hashOpaqueToken(token));

    await expect(accountService.acceptInvitation(token, { token, ...accept })).rejects.toThrow(
      /invalid, has expired, or has already been used/i,
    );
  });

  it('retires an earlier invitation to the same address', async () => {
    await accountService.inviteResident(inviter(), {
      email: 'chidi@example.com',
      category: 'tenant',
    });
    const first = linkToken('/accept-invitation');

    await accountService.inviteResident(inviter(), {
      email: 'chidi@example.com',
      category: 'tenant',
    });
    const second = linkToken('/accept-invitation');

    await expect(
      accountService.acceptInvitation(first, { token: first, ...accept }),
    ).rejects.toThrow();

    await expect(
      accountService.acceptInvitation(second, { token: second, ...accept }),
    ).resolves.toMatchObject({ userId: expect.any(String) });
  });
});
