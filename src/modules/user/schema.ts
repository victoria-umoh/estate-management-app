import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { EncryptedField } from '@/core/crypto';

/**
 * Global user account.
 *
 * NOT tenant-scoped. Login happens before an estate is known — the caller
 * supplies an email and which estates they belong to is the answer, not the
 * question. Estate-specific facts (resident category, property, approval state)
 * live in `memberships`, which is tenant-scoped.
 *
 * Identity fields are stored twice: encrypted for retrieval, and as a blind
 * index for uniqueness and duplicate detection. The index is what enforces "one
 * account per NIN" without the database ever holding a readable NIN.
 */
export type UserStatus = 'pending' | 'active' | 'suspended' | 'locked' | 'deactivated';

export interface UserDoc {
  _id: Types.ObjectId;

  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: Date;
  gender?: 'male' | 'female' | 'other' | 'undisclosed';

  /** Normalised lowercase. Unique across the platform. */
  email: string;
  emailVerifiedAt?: Date | null;

  /** Stored E.164. Unique across the platform. */
  phone: string;
  phoneVerifiedAt?: Date | null;

  /** Encrypted. Never returned by a list endpoint. */
  nin?: EncryptedField | null;
  /** HMAC of the NIN — searchable, unique, not reversible. */
  ninIndex?: string | null;
  /**
   * Last four digits, stored in the clear.
   *
   * Four digits of an eleven-digit number leave ten million combinations, so
   * they identify nobody on their own — and they are the entire purpose of
   * masking: letting staff confirm a match against a physical slip without the
   * full number ever being on screen or decrypted.
   */
  ninLast4?: string | null;
  ninVerifiedAt?: Date | null;
  ninVerificationRef?: string | null;

  /** Blind indexes mirroring email and phone, for duplicate detection. */
  emailIndex: string;
  phoneIndex: string;

  passwordHash: string;
  passwordChangedAt?: Date;

  photoUrl?: string | null;

  twoFactorEnabled: boolean;
  /** Encrypted TOTP seed. */
  twoFactorSecret?: EncryptedField | null;
  twoFactorBackupCodes?: string[];

  status: UserStatus;

  failedLoginAttempts: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  lastLoginIp?: string | null;

  isPlatformAdmin: boolean;

  emergencyContact?: {
    name: string;
    phone: string;
    relationship: string;
  } | null;

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

const userSchema = new Schema<UserDoc>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    middleName: { type: String, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: ['male', 'female', 'other', 'undisclosed'] },

    email: { type: String, required: true, lowercase: true, trim: true },
    emailVerifiedAt: { type: Date, default: null },

    phone: { type: String, required: true, trim: true },
    phoneVerifiedAt: { type: Date, default: null },

    nin: { type: encryptedFieldSchema, default: null },
    ninIndex: { type: String, default: null },
    ninLast4: { type: String, default: null },
    ninVerifiedAt: { type: Date, default: null },
    ninVerificationRef: { type: String, default: null },

    emailIndex: { type: String, required: true },
    phoneIndex: { type: String, required: true },

    // `select: false` so a stray `findOne()` cannot pull the hash into memory
    // or into a response by accident. Login opts in explicitly.
    passwordHash: { type: String, required: true, select: false },
    passwordChangedAt: { type: Date },

    photoUrl: { type: String, default: null },

    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: encryptedFieldSchema, default: null, select: false },
    twoFactorBackupCodes: { type: [String], default: undefined, select: false },

    status: {
      type: String,
      enum: ['pending', 'active', 'suspended', 'locked', 'deactivated'],
      default: 'pending',
      index: true,
    },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: null },

    isPlatformAdmin: { type: Boolean, default: false },

    emergencyContact: {
      type: new Schema(
        {
          name: { type: String, required: true },
          phone: { type: String, required: true },
          relationship: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Uniqueness is enforced on the BLIND INDEX, not the raw value: the index is
// normalised, so "0801 234 5678" and "+2348012345678" collide as they should,
// and a second account cannot be created for a NIN already registered.
// Partial filters exclude soft-deleted rows so a departed user's email can be
// reused, and exclude nulls so users without a NIN do not collide with
// each other.
userSchema.index({ emailIndex: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
userSchema.index({ phoneIndex: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
userSchema.index(
  { ninIndex: 1 },
  { unique: true, partialFilterExpression: { ninIndex: { $type: 'string' }, deletedAt: null } },
);

export const UserModel: Model<UserDoc> =
  (mongoose.models.User as Model<UserDoc>) ?? mongoose.model<UserDoc>('User', userSchema);
