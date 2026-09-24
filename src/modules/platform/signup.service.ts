import { Types } from 'mongoose';
import { config } from '@/core/config';
import { blindIndex, maskEmail } from '@/core/crypto';
import { withTransaction } from '@/core/db';
import { TRIAL_DAYS } from '@/core/entitlements';
import { AuthenticationError, ErrorCode, InternalError } from '@/core/errors';
import { enforceRateLimit } from '@/core/http/rate-limit';
import { createLogger } from '@/core/logging';
import { systemContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import {
  accountTokenRepository,
  assertPasswordStrength,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
} from '@/modules/auth';
import { estateService, estateRepository } from '@/modules/estate';
import { membershipRepository } from '@/modules/membership/repository';
import type { MembershipDoc } from '@/modules/membership/schema';
import { notificationService } from '@/modules/notification';
import { roleRepository } from '@/modules/role';
import { userRepository } from '@/modules/user/repository';
import { allocateEstateSlug } from './slug';

const log = createLogger('signup');

/**
 * Self-serve estate signup.
 *
 * This is the only unauthenticated endpoint in the platform that creates a
 * TENANT. Everything below follows from that.
 *
 *  - **One transaction.** The estate, its system roles, the chairman's account
 *    and the chairman's membership commit together or not at all. A half-created
 *    estate — roles with no chairman, or a chairman with no estate — cannot be
 *    repaired through any screen the product has, because every repair screen is
 *    behind a membership of the estate that failed to exist.
 *
 *  - **No enumeration.** The response is byte-identical whether or not the
 *    address is already registered, and the existing holder is emailed instead,
 *    exactly as `auth.register` does. The expensive half of the work — the
 *    argon2 hash — runs on both paths so the duplicate branch is not detectably
 *    faster, and a floor is applied under both.
 *
 *  - **The slug is ours.** Derived from the estate name, sanitised, length-
 *    capped, checked against a reserved list and made unique with random
 *    material. Nothing from the request reaches it verbatim, so a signup cannot
 *    squat `/api`, collide with an existing estate, or choose its own
 *    identifier.
 *
 *  - **The estate is not usable until the address is verified.** The chairman's
 *    membership is created `pending`, which is what login refuses; verifying the
 *    emailed link is what promotes it to `active`. Until then the estate has no
 *    active member, so nobody can sign into it — including the person who
 *    created it. This is why the trial clock is not the only gate: an unverified
 *    signup is inert rather than merely unbilled.
 */

/** The chairman's role code, seeded into every new estate by `roleService`. */
const CHAIRMAN_ROLE = 'estate-chairman';

/** Short, as for every other emailed link: an hour of exposure, not a day. */
const VERIFICATION_TTL_MS = 60 * 60_000;

/**
 * The floor every signup response is padded to.
 *
 * Covers the duplicate branch, whose real work is one indexed lookup and a
 * queue push. The creating branch is slower than this and cannot be hidden
 * entirely — the same residual signal `auth.register` accepts — but the gross
 * difference between "did nothing" and "created a tenant" is closed.
 */
const RESPONSE_FLOOR_MS = 900;

async function withFloor<T>(work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    const remaining = RESPONSE_FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export interface SignupResult {
  /** Always the same sentence, whatever happened. */
  message: string;
}

export interface SignupVerification {
  estateName: string;
  estateSlug: string;
  trialEndsAt: Date | null;
}

export interface SignupChannel {
  ip?: string;
}

export class SignupService {
  /**
   * Begin a signup.
   *
   * Returns nothing that varies with the outcome. The caller learns whether the
   * address was already in use only by reading the inbox that owns it.
   */
  async start(
    input: {
      estateName: string;
      address: {
        line1: string;
        line2?: string;
        city: string;
        state: string;
        country: string;
        postalCode?: string;
      };
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      password: string;
    },
    channel: SignupChannel = {},
  ): Promise<SignupResult> {
    // Keyed on the blind index of the address, so the counter cannot be read
    // back into an email, and consumed BEFORE any lookup so an address that
    // does not exist is throttled exactly like one that does. The route limits
    // by IP as well; this is the half that survives a rotating source address.
    await enforceRateLimit(
      { key: 'user', limit: 3, window: '24h', bucket: 'signup:address' },
      { userId: blindIndex(input.email, 'email'), route: 'signup:address' },
    );

    // Before the duplicate check, so a weak password is refused identically for
    // a taken address and a free one.
    assertPasswordStrength(input.password, {
      email: input.email,
      name: `${input.firstName} ${input.lastName}`,
    });

    return withFloor(async () => {
      // Run on both branches. It is the dominant cost of a signup, so skipping
      // it on the duplicate path would make that path measurably faster and
      // hand back the oracle the uniform response exists to close.
      const passwordHash = await hashPassword(input.password);

      const duplicate = await userRepository.findDuplicate({
        email: input.email,
        phone: input.phone,
      });

      if (duplicate) {
        /**
         * Tell the account holder, not the person at the form.
         *
         * If the address is theirs, the email arrives and tells them to sign in
         * instead — so somebody who forgot they had signed up is not stuck. If
         * it is not theirs, they learn nothing and the real owner learns that
         * somebody tried.
         *
         * Note this fires for a duplicate PHONE as well, in which case the mail
         * goes to the address that was typed rather than to the phone's owner.
         * That is the lesser evil: the alternative is answering differently for
         * a taken phone number, which is the same oracle in another field.
         */
        await notificationService.sendToAddress({
          to: input.email,
          templateId: 'account.duplicate-registration',
          data: { name: input.firstName, signInUrl: `${config.app.url}/login` },
        });

        log.info({ email: maskEmail(input.email) }, 'signup refused: identifier already in use');
        return { message: SIGNUP_MESSAGE };
      }

      const slug = await allocateEstateSlug(input.estateName);

      const created = await withTransaction(async (session) => {
        const estate = await estateService.create(
          {
            name: input.estateName,
            slug,
            address: input.address,
            // The chairman is the estate's contact until somebody edits it.
            // There is nobody else yet.
            contact: { email: input.email, phone: input.phone },
          },
          { session },
        );

        const estateId = estate._id.toHexString();
        const context = systemContext(estateId, 'signup');

        const chairmanRole = await roleRepository.findByCode(context, CHAIRMAN_ROLE, { session });
        if (!chairmanRole) {
          // Unreachable unless role seeding silently changed: `estateService`
          // seeds inside this same transaction. Loud rather than silent,
          // because the failure mode it guards is an estate nobody can admin.
          throw new InternalError('The chairman role was not seeded for the new estate.');
        }

        const user = await userRepository.create(
          {
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            phone: input.phone,
            emailIndex: blindIndex(input.email, 'email'),
            phoneIndex: blindIndex(input.phone, 'phone'),
            passwordHash,
            // Promoted to `active` when the emailed link is redeemed.
            status: 'pending',
            twoFactorEnabled: false,
            failedLoginAttempts: 0,
            // Self-serve signup does not make anyone platform staff. Stated
            // rather than defaulted, because this is the field that would turn
            // a public form into a cross-tenant console.
            isPlatformAdmin: false,
          },
          { session },
        );

        const membership = await membershipRepository.create(
          context,
          {
            userId: user._id,
            category: 'estate-staff',
            // `pending` is what login refuses. The estate exists and its trial
            // is running, but nobody can sign in until the address is proved.
            status: 'pending',
            roleIds: [chairmanRole._id],
          } as Partial<MembershipDoc>,
          { session },
        );

        await auditService.record(context, {
          action: 'estate.signup_started',
          resource: 'estate',
          resourceId: estate._id,
          metadata: {
            slug: estate.slug,
            chairmanEmail: maskEmail(input.email),
            trialDays: TRIAL_DAYS,
            ...(channel.ip ? { ip: channel.ip } : {}),
          },
          session,
        });

        return {
          estateId,
          userId: user._id,
          membershipId: membership._id.toHexString(),
          firstName: user.firstName,
          email: user.email,
        };
      });

      // Issued AFTER the transaction commits, never inside it. A verification
      // link for an estate that rolled back is a link to nothing, and
      // `sendToAddress` swallows its own failures so a mail queue that is
      // briefly down costs a resend rather than the whole signup.
      await this.issueVerification(created, channel);

      log.info(
        { estateId: created.estateId, slug, email: maskEmail(input.email) },
        'estate signup created, awaiting email verification',
      );

      return { message: SIGNUP_MESSAGE };
    });
  }

  /**
   * Redeem the emailed link and make the estate usable.
   *
   * Unlike `start`, this one reports failure: the caller holds a token rather
   * than an address, and "this link has expired, ask for another" is the only
   * useful thing to say. An unknown token and an expired one give the same
   * message, so a probe learns nothing about which.
   */
  async verify(token: string): Promise<SignupVerification> {
    const record = await accountTokenRepository.consume(
      'email-verification',
      hashOpaqueToken(token),
    );

    if (!record?.userId || !record.estateId) {
      throw new AuthenticationError(
        'That link is invalid or has expired. Ask for a new one by signing up again.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const estateId = record.estateId.toHexString();
    const userId = record.userId;

    const estate = await estateRepository.findById(estateId);
    if (!estate || estate.deletedAt) {
      throw new AuthenticationError(
        'That link is invalid or has expired. Ask for a new one by signing up again.',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const context = systemContext(estateId, 'signup');

    await withTransaction(async (session) => {
      await userRepository.updateById(
        userId,
        { $set: { emailVerifiedAt: new Date(), status: 'active' } },
        { session },
      );

      // Scoped to the estate the TOKEN names, not one supplied by the caller.
      const membership = await membershipRepository.updateOne(
        context,
        { userId: new Types.ObjectId(userId), status: 'pending' },
        { $set: { status: 'active', approvedAt: new Date() } },
        { session },
      );

      if (!membership) {
        // Already verified, or the membership was changed in between. Not an
        // error worth failing on — the token is spent either way — but worth
        // seeing, because it should not happen twice.
        log.warn({ estateId }, 'signup verification found no pending chairman membership');
      }

      await auditService.record(context, {
        action: 'estate.signup_verified',
        resource: 'estate',
        resourceId: estateId,
        metadata: { slug: estate.slug },
        session,
      });
    });

    log.info({ estateId, slug: estate.slug }, 'estate signup verified');

    return {
      estateName: estate.name,
      estateSlug: estate.slug,
      trialEndsAt: estate.trialEndsAt ?? null,
    };
  }

  // ---------------------------------------------------------------------------

  /** Mint a single-use link and email it. Only the hash is stored. */
  private async issueVerification(
    subject: { estateId: string; userId: Types.ObjectId; firstName: string; email: string },
    channel: SignupChannel,
  ): Promise<void> {
    const { token, hash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    await accountTokenRepository.create({
      purpose: 'email-verification',
      tokenHash: hash,
      expiresAt,
      consumedAt: null,
      userId: subject.userId,
      estateId: new Types.ObjectId(subject.estateId),
      emailIndex: blindIndex(subject.email, 'email'),
      ...(channel.ip ? { requestedIp: channel.ip } : {}),
    });

    await notificationService.sendToAddress({
      to: subject.email,
      templateId: 'estate.signup-verification',
      data: {
        name: subject.firstName,
        // A signup link of its own rather than the shared `/verify-email` page:
        // redeeming it activates the chairman's MEMBERSHIP as well as the
        // account, and the shared page does not do that.
        verificationUrl: `${config.app.url}/signup/verify?token=${token}`,
        expiresInMinutes: Math.round(VERIFICATION_TTL_MS / 60_000),
        trialDays: TRIAL_DAYS,
      },
    });
  }
}

/**
 * The one sentence every signup gets.
 *
 * It describes what happens next without asserting that an account was created,
 * which is what lets it be true on both branches.
 */
export const SIGNUP_MESSAGE =
  'Check your email. If we can set up an estate for that address, a link to finish is on its way.';

export const signupService = new SignupService();

/** Exported so the tests can assert the link really does expire. */
export const SIGNUP_VERIFICATION_TTL_MS = VERIFICATION_TTL_MS;
