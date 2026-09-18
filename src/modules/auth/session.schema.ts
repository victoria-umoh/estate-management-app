import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * A login session, bound to one device.
 *
 * Refresh tokens are stored ONLY as SHA-256 hashes, so a database dump does not
 * yield usable tokens.
 *
 * Sessions form a "family": each rotation supersedes the previous token within
 * the same session. Presenting an already-rotated token means two parties hold
 * the same credential — the legitimate client and a thief — so the entire
 * family is revoked rather than guessing which is which.
 */
export type SessionRevocationReason =
  'logout' | 'logout-all' | 'rotation-reuse' | 'password-changed' | 'admin-revoked' | 'expired';

export interface SessionDoc {
  _id: Types.ObjectId;

  userId: Types.ObjectId;
  /** Estate this session is operating in. */
  estateId: Types.ObjectId;

  /** SHA-256 of the current refresh token. Never the token itself. */
  refreshTokenHash: string;
  /** Previous hash, retained briefly so a racing retry is not misread as theft. */
  previousTokenHash?: string | null;
  rotatedAt?: Date | null;

  device: {
    /** Stable per-install identifier supplied by the client. */
    deviceId?: string | null;
    name?: string | null;
    userAgent?: string | null;
    ip?: string | null;
  };

  expiresAt: Date;
  lastUsedAt: Date;

  revokedAt?: Date | null;
  revokedReason?: SessionRevocationReason | null;

  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    estateId: { type: Schema.Types.ObjectId, required: true },

    refreshTokenHash: { type: String, required: true },
    previousTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },

    device: {
      deviceId: { type: String, default: null },
      name: { type: String, default: null },
      userAgent: { type: String, default: null },
      ip: { type: String, default: null },
    },

    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },

    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: true },
);

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
// Needed to detect reuse of a token that has already been rotated away.
sessionSchema.index({ previousTokenHash: 1 }, { sparse: true });
sessionSchema.index({ userId: 1, revokedAt: 1 });

// Mongo removes expired sessions automatically. Revocation still happens
// explicitly — this is cleanup, not a security control, because a TTL sweep can
// lag by up to a minute.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel: Model<SessionDoc> =
  (mongoose.models.Session as Model<SessionDoc>) ??
  mongoose.model<SessionDoc>('Session', sessionSchema);
