import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';
import type { TokenSubject } from '@/core/crypto';

/**
 * The gate's single source of truth.
 *
 * This collection is deliberately denormalised. A gate scan happens hundreds of
 * times a day on a cheap tablet over a poor connection, and it must resolve in
 * one indexed lookup — no `$lookup`, no populate, no second round trip to find
 * the resident's name or house number. Everything the gate screen renders is
 * copied here at issue time.
 *
 * The cost of that choice is that copies go stale. Domain events
 * (`resident.approved`, `vehicle.blacklisted`, `credential.revoked`) keep them
 * in step, and `syncedAt` records when each row was last reconciled so drift is
 * visible rather than silent.
 *
 * Rows are keyed by the SHA-256 of the issued token, never the token itself, so
 * a database dump does not hand an attacker a set of working passes.
 */
export type CredentialStatus = 'active' | 'suspended' | 'revoked' | 'expired';

export interface AccessCredentialDoc extends TenantDocument {
  /** SHA-256 of the issued token. The lookup key. */
  tokenHash: string;
  /** Token id, for revoking one issue without touching its siblings. */
  jti: string;

  subject: TokenSubject;
  /** Membership, vehicle or pass this credential admits. */
  subjectId: Types.ObjectId;

  /**
   * Exactly what the gate screen shows. Nothing here is sensitive: an officer
   * needs to know this person or vehicle belongs, and which house it is for.
   */
  display: {
    primaryLabel: string;
    secondaryLabel?: string | null;
    unitNumber?: string | null;
    category?: string | null;
    photoUrl?: string | null;
  };

  status: CredentialStatus;

  /** Checked before status, so a blacklist cannot be bypassed by a stale copy. */
  blacklisted: boolean;
  blacklistReason?: string | null;

  validFrom: Date;
  validUntil?: Date | null;

  /** Bumped on every rotation, so an old QR photograph fails verification. */
  version: number;

  issuedAt: Date;
  issuedBy: Types.ObjectId;
  revokedAt?: Date | null;
  revokedReason?: string | null;

  /** Last reconciliation with the source record. */
  syncedAt: Date;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const accessCredentialSchema = new Schema<AccessCredentialDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    tokenHash: { type: String, required: true },
    jti: { type: String, required: true },

    subject: {
      type: String,
      required: true,
      enum: ['resident', 'vehicle', 'visitor', 'exit-pass', 'temporary-pass'],
    },
    subjectId: { type: Schema.Types.ObjectId, required: true },

    display: {
      primaryLabel: { type: String, required: true },
      secondaryLabel: { type: String, default: null },
      unitNumber: { type: String, default: null },
      category: { type: String, default: null },
      photoUrl: { type: String, default: null },
    },

    status: {
      type: String,
      enum: ['active', 'suspended', 'revoked', 'expired'],
      default: 'active',
    },

    blacklisted: { type: Boolean, default: false },
    blacklistReason: { type: String, default: null },

    validFrom: { type: Date, required: true, default: Date.now },
    validUntil: { type: Date, default: null },

    version: { type: Number, default: 1 },

    issuedAt: { type: Date, required: true, default: Date.now },
    issuedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },

    syncedAt: { type: Date, default: Date.now },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * THE gate index.
 *
 * Unique and not compounded with estateId, because the gate looks a credential
 * up by token hash alone — it does not yet know which estate the scan belongs
 * to. The token itself carries the estate, and verification checks that the two
 * agree, so a token issued by one estate cannot be admitted by another's gate.
 */
accessCredentialSchema.index({ tokenHash: 1 }, { unique: true });

accessCredentialSchema.index({ estateId: 1, subject: 1, subjectId: 1, status: 1 });
accessCredentialSchema.index({ estateId: 1, status: 1, validUntil: 1 });
// Used by the sweep that expires credentials whose window has closed.
accessCredentialSchema.index({ validUntil: 1, status: 1 });

export const AccessCredentialModel: Model<AccessCredentialDoc> =
  (mongoose.models.AccessCredential as Model<AccessCredentialDoc>) ??
  mongoose.model<AccessCredentialDoc>(
    'AccessCredential',
    accessCredentialSchema,
    'access_credentials',
  );
