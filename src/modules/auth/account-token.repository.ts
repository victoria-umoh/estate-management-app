import { Types } from 'mongoose';
import { PlatformRepository } from '@/core/db';
import {
  AccountTokenModel,
  type AccountTokenDoc,
  type AccountTokenPurpose,
} from './account-token.schema';

/**
 * Account tokens are looked up by hash before any estate context exists — the
 * presenter of a reset link is by definition not signed in — so this extends
 * PlatformRepository. Invitations still carry the estate they belong to.
 */
export class AccountTokenRepository extends PlatformRepository<AccountTokenDoc> {
  constructor() {
    super(AccountTokenModel);
  }

  /**
   * Redeem a token, atomically.
   *
   * One conditional update: the filter demands the token is unconsumed and
   * unexpired, and the update stamps it consumed. Mongo applies a single
   * document update atomically, so of two concurrent redemptions exactly one
   * matches and the other gets null. Returning the pre-update document is
   * deliberate — `new: false` — because the caller wants what the token
   * granted, not the fact that it has just been spent.
   *
   * Expiry is part of the FILTER rather than a check on the returned document.
   * Checking afterwards would consume an expired token and then reject it,
   * which is harmless but makes the audit trail lie.
   */
  async consume(purpose: AccountTokenPurpose, tokenHash: string): Promise<AccountTokenDoc | null> {
    return AccountTokenModel.findOneAndUpdate(
      { purpose, tokenHash, consumedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } },
      { new: false },
    )
      .lean<AccountTokenDoc>()
      .exec();
  }

  /**
   * Retire every outstanding token of a purpose for one account.
   *
   * Called when a new one is issued and when one is redeemed: a user who asked
   * for three reset links should not be leaving two live credentials in three
   * different inboxes.
   */
  async consumeAllForUser(
    purpose: AccountTokenPurpose,
    userId: string | Types.ObjectId,
  ): Promise<number> {
    return this.updateMany(
      { purpose, userId: new Types.ObjectId(userId), consumedAt: null },
      { $set: { consumedAt: new Date() } },
    );
  }

  /** The same, keyed by the blind index of an address — used for invitations. */
  async consumeAllForEmailIndex(
    purpose: AccountTokenPurpose,
    emailIndex: string,
    estateId?: string | Types.ObjectId,
  ): Promise<number> {
    return this.updateMany(
      {
        purpose,
        emailIndex,
        consumedAt: null,
        ...(estateId ? { estateId: new Types.ObjectId(estateId) } : {}),
      },
      { $set: { consumedAt: new Date() } },
    );
  }
}

export const accountTokenRepository = new AccountTokenRepository();
