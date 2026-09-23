import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';
import type { EncryptedField } from '@/core/crypto';

/**
 * A requested change to a field that cannot be edited freely.
 *
 * Some resident details are load-bearing. A NIN identifies a person; a phone
 * number receives OTPs and is a password-reset path; a property or category
 * decides what the gate admits and who is billed. Letting a resident change
 * those unilaterally would make account takeover and quiet reassignment
 * trivial, so they are proposed here and reviewed by someone with authority.
 *
 * Which fields require this is configurable per estate — an estate that trusts
 * its residents to correct their own phone number can turn that one off.
 */
export type ChangeableField = 'nin' | 'phone' | 'email' | 'propertyId' | 'category' | 'name';

export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ChangeRequestDoc extends TenantDocument {
  membershipId: Types.ObjectId;
  /** The account the change applies to. */
  userId: Types.ObjectId;

  field: ChangeableField;

  /**
   * Proposed value. Encrypted when the field is itself sensitive, so a pending
   * request does not become a plaintext copy of the thing being protected.
   */
  requestedValue?: string | null;
  requestedValueEncrypted?: EncryptedField | null;

  /** Human-readable summary of the current value, for the reviewer. Masked. */
  currentValueLabel?: string | null;
  requestedValueLabel?: string | null;

  reason?: string | null;
  /** Supporting evidence, e.g. a NIN slip. */
  documentIds: Types.ObjectId[];

  status: ChangeRequestStatus;

  requestedBy: Types.ObjectId;
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  reviewNote?: string | null;
  /**
   * The value is already held by another account.
   *
   * Recorded for the reviewer rather than returned to the submitter. Telling
   * the submitter turned this endpoint into an identity oracle: post a NIN,
   * and a rejection confirmed it belongs to a real account somewhere on the
   * platform — no permission, no audit entry, and across tenants, which is
   * precisely what the audited NIN lookup exists to prevent.
   */
  identityConflict?: boolean;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const encryptedFieldSchema = new Schema(
  {
    ct: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    v: { type: Number, required: true },
  },
  { _id: false },
);

const changeRequestSchema = new Schema<ChangeRequestDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    membershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    field: {
      type: String,
      required: true,
      enum: ['nin', 'phone', 'email', 'propertyId', 'category', 'name'],
    },

    requestedValue: { type: String, default: null },
    requestedValueEncrypted: { type: encryptedFieldSchema, default: null },

    currentValueLabel: { type: String, default: null },
    requestedValueLabel: { type: String, default: null },

    reason: { type: String, trim: true, maxlength: 1000, default: null },
    documentIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Document' },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'withdrawn'],
      default: 'pending',
    },

    requestedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    reviewedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    reviewedAt: { type: Date, default: null },
    identityConflict: { type: Boolean, default: false },
    reviewNote: { type: String, trim: true, maxlength: 1000, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

changeRequestSchema.index({ estateId: 1, status: 1, createdAt: -1 });
changeRequestSchema.index({ estateId: 1, membershipId: 1, createdAt: -1 });

// One pending request per field per membership. Two competing requests for the
// same field would let a reviewer approve one while the other is still open,
// leaving the second to overwrite it later without a second review.
changeRequestSchema.index(
  { estateId: 1, membershipId: 1, field: 1 },
  { unique: true, partialFilterExpression: { status: 'pending', deletedAt: null } },
);

export const ChangeRequestModel: Model<ChangeRequestDoc> =
  (mongoose.models.ChangeRequest as Model<ChangeRequestDoc>) ??
  mongoose.model<ChangeRequestDoc>('ChangeRequest', changeRequestSchema, 'change_requests');
