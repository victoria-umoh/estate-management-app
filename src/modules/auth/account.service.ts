import { Types } from 'mongoose';
import { config } from '@/core/config';
import { blindIndex, maskEmail } from '@/core/crypto';
import { withTransaction } from '@/core/db';
import { AuthenticationError, ConflictError, ErrorCode } from '@/core/errors';
import { enforceRateLimit } from '@/core/http/rate-limit';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { estateRepository } from '@/modules/estate';
import { membershipRepository } from '@/modules/membership/repository';
import type { MembershipDoc } from '@/modules/membership/schema';
import { notificationService } from '@/modules/notification';
import { propertyRepository } from '@/modules/property';
import { userRepository } from '@/modules/user/repository';
import type { UserDoc } from '@/modules/user/schema';
import { accountTokenRepository } from './account-token.repository';
import type { AccountTokenDoc, AccountTokenPurpose } from './account-token.schema';
import type { AcceptInvitationInput, InviteResidentInput } from './dto';
import { assertPasswordStrength, hashPassword } from './password';
import { sessionRepository } from './session.repository';
import { generateOpaqueToken, hashOpaqueToken } from './tokens';

const log = createLogger('auth:account');

/**
 * The flows that reach a person through their inbox.
 *
 * Three rules shape all of them.
 *
 * 1. A token is opaque random material, stored only as a hash, valid once, and
 *    dead at a fixed time. Redemption is a conditional update, so two requests
 *    racing the same link cannot both win.
 * 2. None of these endpoints may reveal whether an address is registered.
 *    That means the same response body, the same status code, AND the same
 *    latency — an endpoint that answers in 8ms for a stranger and 180ms for a
 *    customer is an account-enumeration oracle with extra steps.
 * 3. Anything that changes a password takes every session with it. Someone
 *    resetting a password may be doing it precisely because somebody else is
 *    signed in as them.
 */

/** Short. A verification link that lives for a day is a day of exposure for no benefit. */
const EMAIL_VERIFICATION_TTL_MS = 60 * 60_000;
const PASSWORD_RESET_TTL_MS = 30 * 60_000;
const INVITATION_TTL_DAYS = 7;

/**
 * The floor every enumeration-sensitive response is padded to.
 *
 * Generous enough to cover the slow path — a user lookup, a token write and a
 * queue push — on a loaded machine, because padding that the real work
 * regularly overruns is padding that does not hide anything.
 */
const UNIFORM_RESPONSE_FLOOR_MS = 350;

async function withUniformTiming<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    const remaining = UNIFORM_RESPONSE_FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export interface IssuedAccountToken {
  token: string;
  expiresAt: Date;
}

export class AccountService {
  // ---------------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------------

  /**
   * Issue a verification link and send it.
   *
   * Called from registration, and again from the resend endpoint. Any earlier
   * verification token for the account is retired first: a user who clicked
   * "resend" three times should not be leaving two live links behind.
   *
   * Returns the plaintext token so tests and the registration path can assert
   * on it. Nothing else may keep it.
   */
  async issueEmailVerification(
    user: Pick<UserDoc, '_id' | 'firstName' | 'email'>,
    options: { estateId?: string; ip?: string } = {},
  ): Promise<IssuedAccountToken> {
    await accountTokenRepository.consumeAllForUser('email-verification', user._id);

    const { token, expiresAt } = await this.issue('email-verification', {
      userId: user._id,
      email: user.email,
      ttlMs: EMAIL_VERIFICATION_TTL_MS,
      ...(options.estateId ? { estateId: options.estateId } : {}),
      ...(options.ip ? { ip: options.ip } : {}),
    });

    await notificationService.sendToAddress({
      to: user.email,
      templateId: 'account.email-verification',
      data: {
        name: user.firstName,
        verificationUrl: `${config.app.url}/verify-email?token=${token}`,
        expiresInMinutes: Math.round(EMAIL_VERIFICATION_TTL_MS / 60_000),
      },
    });

    return { token, expiresAt };
  }

  /**
   * Resend a verification link.
   *
   * Public, so it answers identically for an unknown address, for an address
   * that is already verified, and for one that genuinely needed a new link.
   */
  async resendEmailVerification(email: string, ip?: string): Promise<void> {
    await this.enforcePerAccountLimit('auth:verify-email-resend', email, 3, '1h');

    await withUniformTiming(async () => {
      const user = await userRepository.findByEmail(email);
      // Already verified is also a silent no-op: telling the caller "that is
      // already confirmed" confirms the address exists just as loudly as an
      // error would.
      if (!user || user.emailVerifiedAt) return;

      await this.issueEmailVerification(user, ip ? { ip } : {});
    });
  }

  /**
   * Redeem a verification link.
   *
   * Unlike the request side, this one does report failure: the caller is
   * holding a token, not an address, and "this link has expired, ask for
   * another" is the only useful thing to say. A wrong token and an expired
   * token give the same message, so a probe learns nothing about which.
   */
  async verifyEmail(token: string): Promise<{ verified: true; userId: string }> {
    const record = await accountTokenRepository.consume(
      'email-verification',
      hashOpaqueToken(token),
    );

    if (!record?.userId) {
      throw new AuthenticationError(
        'That verification link is invalid or has expired. Request a new one.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const user = await userRepository.findById(record.userId);
    if (!user || user.deletedAt) {
      throw new AuthenticationError(
        'That verification link is invalid or has expired. Request a new one.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    await userRepository.updateById(user._id, {
      $set: {
        emailVerifiedAt: new Date(),
        // Verification proves the address, not the residency: an administrator
        // still has to approve the membership. Moving the USER off `pending` is
        // what that account was waiting on.
        ...(user.status === 'pending' ? { status: 'active' as const } : {}),
      },
    });

    log.info({ userId: user._id.toHexString() }, 'email verified');
    return { verified: true, userId: user._id.toHexString() };
  }

  // ---------------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------------

  /**
   * Ask for a reset link.
   *
   * ALWAYS succeeds, from the caller's point of view. An unknown address, a
   * deleted account and a suspended one all produce the same body, the same
   * status and — via the timing floor — the same latency. The rate limit is
   * keyed on the submitted address rather than on whether it resolves, so even
   * a 429 carries no signal.
   */
  async requestPasswordReset(email: string, ip?: string): Promise<void> {
    await this.enforcePerAccountLimit('auth:password-reset-request', email, 3, '1h');

    await withUniformTiming(async () => {
      const user = await userRepository.findByEmail(email);
      if (!user) return;

      // A suspended or deactivated account gets no link. Resetting the password
      // would not let them back in, and sending it would confirm the address.
      if (user.status === 'suspended' || user.status === 'deactivated') return;

      // Outstanding links are retired as each new one is issued, so the newest
      // email is always the only one that works.
      await accountTokenRepository.consumeAllForUser('password-reset', user._id);

      const { token } = await this.issue('password-reset', {
        userId: user._id,
        email: user.email,
        ttlMs: PASSWORD_RESET_TTL_MS,
        ...(ip ? { ip } : {}),
      });

      await notificationService.sendToAddress({
        to: user.email,
        templateId: 'account.password-reset',
        data: {
          name: user.firstName,
          resetUrl: `${config.app.url}/reset-password?token=${token}`,
          expiresInMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60_000),
        },
      });

      log.info({ userId: user._id.toHexString(), email: maskEmail(user.email) }, 'reset requested');
    });
  }

  /**
   * Redeem a reset link and set a new password.
   *
   * Every session falls with it. This is the whole point of the flow: the
   * likeliest reason someone is here is that they believe another party has
   * their password, and leaving that party's refresh token alive would make the
   * reset cosmetic.
   */
  async resetPassword(token: string, password: string): Promise<{ sessionsRevoked: number }> {
    const record = await accountTokenRepository.consume('password-reset', hashOpaqueToken(token));

    if (!record?.userId) {
      throw new AuthenticationError(
        'That reset link is invalid or has already been used. Request a new one.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const user = await userRepository.findByIdWithSecrets(record.userId.toHexString());
    if (!user || user.deletedAt) {
      throw new AuthenticationError(
        'That reset link is invalid or has already been used. Request a new one.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    assertPasswordStrength(password, {
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
    });

    await userRepository.updateById(user._id, {
      $set: {
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        // A reset link proves control of the inbox, which is the same thing
        // verification proves.
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        // The lockout is cleared: the person who just proved control of the
        // mailbox should not be held out by an attacker's failed guesses.
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const sessionsRevoked = await sessionRepository.revokeAllForUser(user._id, 'password-changed');

    // Any other outstanding reset link dies too — including one an attacker
    // requested moments before.
    await accountTokenRepository.consumeAllForUser('password-reset', user._id);

    log.info(
      { userId: user._id.toHexString(), sessionsRevoked },
      'password reset; all sessions revoked',
    );

    return { sessionsRevoked };
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------

  /**
   * Invite someone to join an estate.
   *
   * The token carries the estate, the property and the category, so none of
   * those are taken from the acceptance request. An invitee who could name
   * their own category would invite themselves to be an estate administrator.
   */
  async inviteResident(
    context: RequestContext,
    input: InviteResidentInput,
  ): Promise<{ invitationId: string; expiresAt: Date }> {
    assertCan(context, PERMISSIONS.RESIDENT_CREATE);

    const emailIndex = blindIndex(input.email, 'email');

    // Someone already in this estate is not invited again — the invitation
    // would create a second membership, which the unique index refuses anyway.
    const existing = await userRepository.findByEmail(input.email);
    if (existing) {
      const membership = await membershipRepository.findByUserAndEstate(
        existing._id,
        context.estateId,
      );
      if (membership && membership.status !== 'exited') {
        throw new ConflictError('That person is already a member of this estate.');
      }
    }

    if (input.propertyId) {
      // Scoped by the caller's context, so a property id from another estate is
      // a 404 rather than a cross-tenant invitation.
      await propertyRepository.findByIdOrFail(context, input.propertyId);
    }

    // One live invitation per address per estate.
    await accountTokenRepository.consumeAllForEmailIndex(
      'invitation',
      emailIndex,
      context.estateId,
    );

    const inviter = await membershipRepository.findOne(context, {
      userId: new Types.ObjectId(context.userId),
    });

    const { token, expiresAt, id } = await this.issue('invitation', {
      email: input.email,
      estateId: context.estateId,
      ttlMs: INVITATION_TTL_DAYS * 86_400_000,
      ...(context.ip ? { ip: context.ip } : {}),
      invitation: {
        email: input.email,
        category: input.category,
        propertyId: input.propertyId ? new Types.ObjectId(input.propertyId) : null,
        invitedByMembershipId: inviter?._id ?? null,
      },
    });

    const [estate, property, inviterUser] = await Promise.all([
      estateRepository.findById(context.estateId),
      input.propertyId ? propertyRepository.findById(context, input.propertyId) : null,
      userRepository.findById(context.userId),
    ]);

    await notificationService.sendToAddress({
      to: input.email,
      templateId: 'account.invitation',
      data: {
        inviterName: inviterUser
          ? `${inviterUser.firstName} ${inviterUser.lastName}`
          : 'An administrator',
        estateName: estate?.name ?? 'your estate',
        propertyLabel: property
          ? `${property.block ? `${property.block} ` : ''}${property.unitNumber}, ${property.street}`
          : 'the estate',
        invitationUrl: `${config.app.url}/accept-invitation?token=${token}`,
        expiresInDays: INVITATION_TTL_DAYS,
      },
    });

    await auditService.record(context, {
      action: 'resident.invited',
      resource: 'membership',
      resourceId: id,
      // The address is masked: the audit log is widely readable within an
      // estate and an invitation that was never accepted is still personal data.
      metadata: { email: maskEmail(input.email), category: input.category },
    });

    return { invitationId: id, expiresAt };
  }

  /**
   * Accept an invitation and become a resident.
   *
   * The account and the membership are written in one transaction, for the same
   * reason registration is: a user with no membership cannot sign in anywhere,
   * and a membership with no user is a dangling row in the estate directory.
   *
   * The token is consumed BEFORE the transaction. That ordering is deliberate:
   * if the account creation then fails, the invitation is spent and must be
   * reissued — annoying, and much better than the alternative, where a token
   * that fails mid-transaction is left redeemable and two people race it.
   */
  async acceptInvitation(
    token: string,
    input: AcceptInvitationInput,
  ): Promise<{ userId: string; membershipId: string }> {
    const record = await accountTokenRepository.consume('invitation', hashOpaqueToken(token));

    if (!record?.invitation || !record.estateId) {
      throw new AuthenticationError(
        'That invitation is invalid, has expired, or has already been used.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const invitation = record.invitation;
    const estateId = record.estateId.toHexString();

    assertPasswordStrength(input.password, {
      email: invitation.email,
      name: `${input.firstName} ${input.lastName}`,
    });

    const duplicate = await userRepository.findDuplicate({
      email: invitation.email,
      phone: input.phone,
    });

    if (duplicate) {
      throw new ConflictError(
        duplicate.field === 'email'
          ? 'An account already exists with that email address. Sign in instead.'
          : 'An account already exists with that phone number.',
        ErrorCode.DUPLICATE_IDENTITY,
      );
    }

    const passwordHash = await hashPassword(input.password);

    const result = await withTransaction(async (session) => {
      const user = await userRepository.create(
        {
          firstName: input.firstName,
          ...(input.middleName ? { middleName: input.middleName } : {}),
          lastName: input.lastName,
          // The address comes from the TOKEN, never from the request body. It
          // is the one thing the invitation actually attests to.
          email: invitation.email,
          phone: input.phone,
          emailIndex: blindIndex(invitation.email, 'email'),
          phoneIndex: blindIndex(input.phone, 'phone'),
          passwordHash,
          status: 'active',
          // Reaching the link proves control of the inbox, which is exactly
          // what the verification flow would establish.
          emailVerifiedAt: new Date(),
          twoFactorEnabled: false,
          failedLoginAttempts: 0,
          isPlatformAdmin: false,
        },
        { session },
      );

      const context = systemContext(estateId, 'invitation-accept');

      const membership = await membershipRepository.create(
        context,
        {
          userId: user._id,
          category: invitation.category,
          // Awaiting approval rather than active: the invitation says who asked
          // them in, not that the estate has finished admitting them.
          status: 'awaiting-approval',
          roleIds: [],
          ...(invitation.propertyId ? { propertyId: invitation.propertyId } : {}),
          ...(invitation.invitedByMembershipId
            ? { guardianMembershipId: invitation.invitedByMembershipId }
            : {}),
        } as Partial<MembershipDoc>,
        { session },
      );

      return { userId: user._id.toHexString(), membershipId: membership._id.toHexString() };
    });

    log.info({ ...result, estateId }, 'invitation accepted');
    return result;
  }

  // ---------------------------------------------------------------------------

  /** Mint a token, persist only its hash, and hand back the plaintext once. */
  private async issue(
    purpose: AccountTokenPurpose,
    input: {
      ttlMs: number;
      userId?: Types.ObjectId;
      estateId?: string;
      email?: string;
      ip?: string;
      invitation?: NonNullable<AccountTokenDoc['invitation']>;
    },
  ): Promise<{ token: string; hash: string; expiresAt: Date; id: string }> {
    const { token, hash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + input.ttlMs);

    const record = await accountTokenRepository.create({
      purpose,
      tokenHash: hash,
      expiresAt,
      consumedAt: null,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.estateId ? { estateId: new Types.ObjectId(input.estateId) } : {}),
      ...(input.email ? { emailIndex: blindIndex(input.email, 'email') } : {}),
      ...(input.invitation ? { invitation: input.invitation } : {}),
      ...(input.ip ? { requestedIp: input.ip } : {}),
    });

    return { token, hash, expiresAt, id: record._id.toHexString() };
  }

  /**
   * Rate limit by the address that was typed, not by the account it resolves to.
   *
   * Keyed on the blind index so the counter cannot be read back into an email,
   * and consumed BEFORE any lookup so that an address which does not exist is
   * throttled exactly like one that does. Routes additionally limit by IP; this
   * is the half of it that survives an attacker rotating addresses.
   */
  private async enforcePerAccountLimit(
    bucket: string,
    email: string,
    limit: number,
    window: string,
  ): Promise<void> {
    await enforceRateLimit(
      { key: 'user', limit, window, bucket },
      { userId: blindIndex(email, 'email'), route: bucket },
    );
  }
}

export const accountService = new AccountService();

/** Exported for the tests that assert the link actually expires. */
export const ACCOUNT_TOKEN_TTL = {
  emailVerificationMs: EMAIL_VERIFICATION_TTL_MS,
  passwordResetMs: PASSWORD_RESET_TTL_MS,
  invitationDays: INVITATION_TTL_DAYS,
} as const;
