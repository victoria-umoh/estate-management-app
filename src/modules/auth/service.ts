import { Types } from 'mongoose';
import { config } from '@/core/config';
import { blindIndex, encryptField, maskEmail, maskPhone } from '@/core/crypto';
import { withTransaction } from '@/core/db';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ErrorCode,
  NotFoundError,
  UnprocessableError,
} from '@/core/errors';
import { createLogger } from '@/core/logging';
import { systemContext } from '@/core/tenancy';
import { events } from '@/core/events';
import { getIdentityProvider } from '@/integrations/identity';
import { membershipRepository } from '@/modules/membership/repository';
import type { MembershipDoc } from '@/modules/membership/schema';
import { userRepository } from '@/modules/user/repository';
import type { UserDoc } from '@/modules/user/schema';
import type { LoginInput, RegisterInput } from './dto';
import {
  assertPasswordStrength,
  burnPasswordVerification,
  hashPassword,
  verifyPassword,
} from './password';
import { sessionRepository } from './session.repository';
import { generateRefreshToken, hashRefreshToken, issueAccessToken } from './tokens';
import { verifyTotp } from './totp';

const log = createLogger('auth');

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface EstateOption {
  estateId: string;
  membershipStatus: string;
  category: string;
}

export interface LoginResult {
  tokens?: AuthTokens;
  /** Set when the user belongs to several estates and must choose. */
  estateChoices?: EstateOption[];
  /** Set when 2FA is enabled and no valid code was supplied. */
  twoFactorRequired?: boolean;
  user: { id: string; firstName: string; lastName: string; email: string };
}

/** Everything the session needs to become a RequestContext. */
interface SessionSubject {
  user: UserDoc;
  membership: MembershipDoc;
}

export class AuthService {
  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Create an account and its estate membership.
   *
   * Both are written in one transaction: a user without a membership could not
   * log in anywhere, and a membership without a user is a dangling reference in
   * an estate's directory.
   */
  async register(input: RegisterInput): Promise<{ userId: string; membershipId: string }> {
    assertPasswordStrength(input.password, {
      email: input.email,
      name: `${input.firstName} ${input.lastName}`,
    });

    // Checked up front to give a clear message. The unique indexes on the blind
    // indexes are the actual guarantee — this check races, that one does not.
    const duplicate = await userRepository.findDuplicate({
      email: input.email,
      phone: input.phone,
    });

    if (duplicate) {
      throw new ConflictError(
        duplicate.field === 'email'
          ? 'An account already exists with that email address.'
          : 'An account already exists with that phone number.',
        ErrorCode.DUPLICATE_IDENTITY,
      );
    }

    const passwordHash = await hashPassword(input.password);

    return withTransaction(async (session) => {
      const user = await userRepository.create(
        {
          firstName: input.firstName,
          ...(input.middleName ? { middleName: input.middleName } : {}),
          lastName: input.lastName,
          ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
          ...(input.gender ? { gender: input.gender } : {}),
          email: input.email,
          phone: input.phone,
          emailIndex: blindIndex(input.email, 'email'),
          phoneIndex: blindIndex(input.phone, 'phone'),
          passwordHash,
          status: 'pending',
          twoFactorEnabled: false,
          failedLoginAttempts: 0,
          isPlatformAdmin: false,
          ...(input.emergencyContact ? { emergencyContact: input.emergencyContact } : {}),
        },
        { session },
      );

      // Registration is the one write that happens without an authenticated
      // context — the user is joining an estate they have merely named, and has
      // no membership there yet. A system context scoped to exactly that estate
      // keeps the tenant guard satisfied without weakening it: the estate is
      // still supplied explicitly and every field is still scoped to it.
      const registrationContext = systemContext(input.estateId);

      const membership = await membershipRepository.create(
        registrationContext,
        {
          userId: user._id,
          category: input.category,
          status: 'pending',
          roleIds: [],
          ...(input.propertyId ? { propertyId: new Types.ObjectId(input.propertyId) } : {}),
        } as Partial<MembershipDoc>,
        { session },
      );

      events.emit('resident.registered', {
        residentId: user._id.toHexString(),
        estateId: input.estateId,
      });

      log.info(
        { userId: user._id.toHexString(), email: maskEmail(input.email) },
        'account registered',
      );

      return { userId: user._id.toHexString(), membershipId: membership._id.toHexString() };
    });
  }

  // ---------------------------------------------------------------------------
  // NIN verification
  // ---------------------------------------------------------------------------

  /**
   * Verify and attach a NIN.
   *
   * Stored encrypted with a blind index. The index carries the uniqueness
   * constraint, so a second account cannot claim a NIN already registered —
   * which is the duplicate-identity control the spec requires.
   */
  async verifyNin(userId: string, nin: string): Promise<{ verified: boolean; reason?: string }> {
    const user = await userRepository.findByIdOrFail(userId);

    const existing = await userRepository.findByNin(nin);
    if (existing && !existing._id.equals(user._id)) {
      // Deliberately does not reveal whose account holds it.
      throw new ConflictError(
        'That NIN is already registered to another account.',
        ErrorCode.DUPLICATE_IDENTITY,
      );
    }

    const result = await getIdentityProvider().verifyNin({
      nin,
      firstName: user.firstName,
      lastName: user.lastName,
      ...(user.dateOfBirth ? { dateOfBirth: user.dateOfBirth } : {}),
      phone: user.phone,
    });

    if (!result.verified) {
      log.warn({ userId, reference: result.reference }, 'NIN verification failed');
      return { verified: false, ...(result.reason ? { reason: result.reason } : {}) };
    }

    await userRepository.updateById(user._id, {
      $set: {
        nin: encryptField(nin, `user:${user._id.toHexString()}:nin`),
        ninIndex: blindIndex(nin, 'nin'),
        ninVerifiedAt: new Date(),
        ninVerificationRef: result.reference,
      },
    });

    log.info({ userId, reference: result.reference }, 'NIN verified');
    return { verified: true };
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async login(
    input: LoginInput,
    request: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    const user = await userRepository.findByEmailWithSecrets(input.email);

    if (!user) {
      // Burn equivalent argon2 work so a missing account is not detectably
      // faster than a wrong password.
      await burnPasswordVerification(input.password);
      throw new AuthenticationError('Incorrect email or password.', ErrorCode.INVALID_CREDENTIALS);
    }

    this.assertNotLocked(user);

    const passwordValid = await verifyPassword(input.password, user.passwordHash);
    if (!passwordValid) {
      await this.recordFailedLogin(user);
      throw new AuthenticationError('Incorrect email or password.', ErrorCode.INVALID_CREDENTIALS);
    }

    this.assertAccountUsable(user);

    // --- Two-factor -----------------------------------------------------------
    if (user.twoFactorEnabled) {
      if (!input.totpCode) {
        return { twoFactorRequired: true, user: this.publicUser(user) };
      }
      if (!user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, input.totpCode)) {
        await this.recordFailedLogin(user);
        throw new AuthenticationError(
          'That authentication code is incorrect.',
          ErrorCode.TWO_FACTOR_REQUIRED,
        );
      }
    }

    // --- Estate selection -----------------------------------------------------
    const memberships = await membershipRepository.findEstatesForUser(user._id);

    if (memberships.length === 0) {
      throw new AuthorizationError(
        'Your account is not linked to an estate yet.',
        ErrorCode.ACCOUNT_PENDING_APPROVAL,
      );
    }

    const selected = input.estateId
      ? memberships.find((m) => m.estateId.toHexString() === input.estateId)
      : memberships.length === 1
        ? memberships[0]
        : undefined;

    if (!selected) {
      // Several estates and no choice made: authentication succeeded but no
      // tokens are issued until a tenant is chosen.
      await this.recordSuccessfulLogin(user, request.ip);
      return {
        estateChoices: memberships.map((m) => ({
          estateId: m.estateId.toHexString(),
          membershipStatus: m.status,
          category: m.category,
        })),
        user: this.publicUser(user),
      };
    }

    if (selected.status !== 'active') {
      throw new AuthorizationError(
        selected.status === 'suspended'
          ? 'Your access to this estate has been suspended.'
          : 'Your membership of this estate is still awaiting approval.',
        selected.status === 'suspended'
          ? ErrorCode.ACCOUNT_SUSPENDED
          : ErrorCode.ACCOUNT_PENDING_APPROVAL,
      );
    }

    const tokens = await this.createSession(
      { user, membership: selected },
      {
        ...request,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      },
    );
    await this.recordSuccessfulLogin(user, request.ip);

    return { tokens, user: this.publicUser(user) };
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  private async createSession(
    subject: SessionSubject,
    request: { ip?: string; userAgent?: string; deviceId?: string; deviceName?: string },
  ): Promise<AuthTokens> {
    const { token: refreshToken, hash } = generateRefreshToken();

    const session = await sessionRepository.create({
      userId: subject.user._id,
      estateId: subject.membership.estateId,
      refreshTokenHash: hash,
      device: {
        deviceId: request.deviceId ?? null,
        name: request.deviceName ?? null,
        userAgent: request.userAgent ?? null,
        ip: request.ip ?? null,
      },
      expiresAt: new Date(Date.now() + config.auth.refreshTtlMs),
      lastUsedAt: new Date(),
    });

    const accessToken = await issueAccessToken({
      userId: subject.user._id.toHexString(),
      estateId: subject.membership.estateId.toHexString(),
      sessionId: session._id.toHexString(),
      roles: [],
      permissions: [],
      isPlatformAdmin: subject.user.isPlatformAdmin,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(config.auth.accessTtlMs / 1000),
    };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Rotation is unconditional: the presented token is invalidated whether or not
   * the client successfully receives the replacement. Reuse of a rotated token
   * means two parties hold it, so the whole session family is revoked.
   */
  async refresh(
    refreshToken: string,
    request: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const presentedHash = hashRefreshToken(refreshToken);
    const session = await sessionRepository.findByRefreshTokenHash(presentedHash);

    if (!session) {
      // Not found as current — check whether it is a token we already rotated
      // away. That is the signature of a stolen token being replayed.
      const reused = await sessionRepository.findByPreviousTokenHash(presentedHash);

      if (reused) {
        log.error(
          { userId: reused.userId.toHexString(), sessionId: reused._id.toHexString() },
          'refresh token reuse detected — revoking all sessions for user',
        );
        // We cannot tell the thief from the legitimate holder, so we evict both
        // and force a fresh login.
        await sessionRepository.revokeAllForUser(reused.userId, 'rotation-reuse');
      }

      throw new AuthenticationError('Your session is no longer valid.', ErrorCode.SESSION_REVOKED);
    }

    if (session.revokedAt) {
      throw new AuthenticationError('Your session has been revoked.', ErrorCode.SESSION_REVOKED);
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new AuthenticationError('Your session has expired.', ErrorCode.TOKEN_EXPIRED);
    }

    const user = await userRepository.findById(session.userId);
    if (!user) throw new AuthenticationError('Your session is no longer valid.');
    this.assertAccountUsable(user);

    const membership = await membershipRepository.findByUserAndEstate(
      session.userId,
      session.estateId,
    );
    if (!membership || membership.status !== 'active') {
      await sessionRepository.revoke(session._id, 'admin-revoked');
      throw new AuthorizationError('Your access to this estate has changed. Please sign in again.');
    }

    const { token: nextToken, hash: nextHash } = generateRefreshToken();

    await sessionRepository.updateById(session._id, {
      $set: {
        refreshTokenHash: nextHash,
        previousTokenHash: presentedHash,
        rotatedAt: new Date(),
        lastUsedAt: new Date(),
        'device.ip': request.ip ?? session.device.ip,
      },
    });

    const accessToken = await issueAccessToken({
      userId: user._id.toHexString(),
      estateId: session.estateId.toHexString(),
      sessionId: session._id.toHexString(),
      roles: [],
      permissions: [],
      isPlatformAdmin: user.isPlatformAdmin,
    });

    return {
      accessToken,
      refreshToken: nextToken,
      expiresIn: Math.floor(config.auth.accessTtlMs / 1000),
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await sessionRepository.findByRefreshTokenHash(hashRefreshToken(refreshToken));
    // Silent when absent: logging out an unknown token is not an error, and
    // reporting one would confirm whether a token was valid.
    if (session) await sessionRepository.revoke(session._id, 'logout');
  }

  async logoutAll(userId: string, exceptSessionId?: string): Promise<number> {
    return sessionRepository.revokeAllForUser(userId, 'logout-all', exceptSessionId);
  }

  // ---------------------------------------------------------------------------
  // Account state
  // ---------------------------------------------------------------------------

  private assertNotLocked(user: UserDoc): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AuthorizationError(
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        ErrorCode.ACCOUNT_LOCKED,
      );
    }
  }

  private assertAccountUsable(user: UserDoc): void {
    if (user.deletedAt) {
      throw new AuthenticationError('Incorrect email or password.', ErrorCode.INVALID_CREDENTIALS);
    }
    if (user.status === 'suspended') {
      throw new AuthorizationError('This account has been suspended.', ErrorCode.ACCOUNT_SUSPENDED);
    }
    if (user.status === 'deactivated') {
      throw new AuthenticationError('Incorrect email or password.', ErrorCode.INVALID_CREDENTIALS);
    }
  }

  /**
   * Count a failed attempt and lock the account once the threshold is reached.
   *
   * The lock is time-bounded rather than permanent, so this cannot be used to
   * deny a resident access to their own estate indefinitely.
   */
  private async recordFailedLogin(user: UserDoc): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= config.auth.maxFailedAttempts;

    await userRepository.updateById(user._id, {
      $set: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + config.auth.lockoutMs) : user.lockedUntil,
      },
    });

    if (shouldLock) {
      log.warn(
        { userId: user._id.toHexString(), email: maskEmail(user.email) },
        'account locked after repeated failed logins',
      );
    }
  }

  private async recordSuccessfulLogin(user: UserDoc, ip?: string): Promise<void> {
    await userRepository.updateById(user._id, {
      $set: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ip ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * The user fields safe to return.
   *
   * An explicit allow-list, not a deny-list: a field added to the schema later
   * cannot leak by being forgotten here.
   */
  private publicUser(user: UserDoc): LoginResult['user'] {
    return {
      id: user._id.toHexString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    };
  }

  /** Masked contact details, for the verification screens. */
  async getVerificationTargets(userId: string): Promise<{ email: string; phone: string }> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('Account');
    return { email: maskEmail(user.email), phone: maskPhone(user.phone) };
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await userRepository.findByIdWithSecrets(userId);
    if (!user) throw new NotFoundError('Account');

    if (!(await verifyPassword(current, user.passwordHash))) {
      throw new AuthenticationError(
        'Your current password is incorrect.',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }

    assertPasswordStrength(next, { email: user.email, name: user.firstName });

    if (await verifyPassword(next, user.passwordHash)) {
      throw new UnprocessableError('Choose a password you have not used before.');
    }

    await userRepository.updateById(user._id, {
      $set: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() },
    });

    // A password change is the standard response to a suspected compromise, so
    // every existing session must fall with it.
    await sessionRepository.revokeAllForUser(user._id, 'password-changed');

    log.info({ userId }, 'password changed; all sessions revoked');
  }
}

export const authService = new AuthService();
