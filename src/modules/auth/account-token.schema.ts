import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * Single-use tokens that arrive by email: verification, password reset and
 * invitation.
 *
 * They follow the refresh token exactly — opaque random material, stored ONLY
 * as a SHA-256 hash, so a database dump yields nothing a reader can present.
 * The difference is that these are consumed rather than rotated: each one is
 * redeemable once, by whoever presents it first, and never again.
 *
 * `consumedAt` is what makes that true, but only because redemption is a
 * CONDITIONAL update — `{ tokenHash, consumedAt: null }` in the filter, the
 * stamp in the update, one round trip. A read-then-write would let two requests
 * arriving in the same millisecond both observe an unconsumed token and both
 * proceed, which on the reset flow means an attacker racing the legitimate user
 * for the same link.
 */
export type AccountTokenPurpose = 'email-verification' | 'password-reset' | 'invitation';

export interface AccountTokenDoc {
  _id: Types.ObjectId;

  purpose: AccountTokenPurpose;
  /** SHA-256 of the token. Never the token itself. */
  tokenHash: string;

  /** The account this token acts on. Null for an invitation — there is no account yet. */
  userId?: Types.ObjectId | null;
  /** The estate the token belongs to, for invitations and for verification context. */
  estateId?: Types.ObjectId | null;

  /**
   * Blind index of the address the token was sent to.
   *
   * Indexed rather than the address itself so outstanding tokens can be found
   * and revoked without the query — or the index — carrying a readable email.
   */
  emailIndex?: string | null;

  /** Invitation-only: what the invitee becomes when they accept. */
  invitation?: {
    email: string;
    category: string;
    propertyId?: Types.ObjectId | null;
    invitedByMembershipId?: Types.ObjectId | null;
  } | null;

  expiresAt: Date;
  consumedAt?: Date | null;

  /** For the audit trail on a redemption that turns out to have been hostile. */
  requestedIp?: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const accountTokenSchema = new Schema<AccountTokenDoc>(
  {
    purpose: {
      type: String,
      required: true,
      enum: ['email-verification', 'password-reset', 'invitation'],
    },
    tokenHash: { type: String, required: true },

    userId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    estateId: { type: Schema.Types.ObjectId, default: null },
    emailIndex: { type: String, default: null },

    invitation: {
      type: new Schema(
        {
          email: { type: String, required: true },
          category: { type: String, required: true },
          propertyId: { type: Schema.Types.ObjectId, default: null },
          invitedByMembershipId: { type: Schema.Types.ObjectId, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    requestedIp: { type: String, default: null },
  },
  { timestamps: true },
);

// Unique, so the same hash cannot exist twice and a redemption cannot ambiguously
// match. This is also what makes the conditional consume a single-document
// operation, and therefore atomic.
accountTokenSchema.index({ tokenHash: 1 }, { unique: true });
// Used to revoke a user's outstanding tokens when one of them is redeemed.
accountTokenSchema.index({ purpose: 1, userId: 1, consumedAt: 1 });
accountTokenSchema.index({ purpose: 1, emailIndex: 1, consumedAt: 1 });

// Cleanup only. Expiry is enforced in the consume filter, because a TTL monitor
// runs about once a minute and a token must be dead the instant it expires.
accountTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const AccountTokenModel: Model<AccountTokenDoc> =
  (mongoose.models.AccountToken as Model<AccountTokenDoc>) ??
  mongoose.model<AccountTokenDoc>('AccountToken', accountTokenSchema);
