import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';
import type { EncryptedField } from '@/core/crypto';

/**
 * A dependant: a household member who lives in the estate but does not hold
 * their own account.
 *
 * Deliberately NOT a `users` record. A five-year-old has no email, no phone and
 * no password, and manufacturing a stub account for one would put a permanently
 * unverifiable, unloginable row in the platform's identity collection — the one
 * place where every row is supposed to be a verified person.
 *
 * A dependant still gets a profile and can be issued an ID, because the gate
 * needs to recognise them. When one later acquires their own account — a
 * teenager getting a phone — `linkedMembershipId` connects the two without
 * rewriting the history.
 */
export type DependantRelationship =
  'child' | 'spouse' | 'parent' | 'sibling' | 'ward' | 'domestic-staff' | 'driver' | 'other';

export interface DependantDoc extends TenantDocument {
  /** The household head responsible for this person. */
  guardianMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  firstName: string;
  middleName?: string | null;
  lastName: string;
  dateOfBirth?: Date | null;
  gender?: 'male' | 'female' | 'other' | 'undisclosed';

  relationship: DependantRelationship;

  /** Present for older dependants and domestic staff. */
  phone?: string | null;
  phoneIndex?: string | null;

  /** Encrypted, as for any account holder. Usually absent for minors. */
  nin?: EncryptedField | null;
  ninIndex?: string | null;
  ninLast4?: string | null;

  photoUrl?: string | null;

  /** Context a security officer may need when a child arrives unaccompanied. */
  schoolOrWorkplace?: string | null;

  /** Set once the dependant has their own account. */
  linkedMembershipId?: Types.ObjectId | null;

  isActive: boolean;
  /** Retained when a dependant leaves, so gate history stays resolvable. */
  departedAt?: Date | null;

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

const dependantSchema = new Schema<DependantDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    guardianMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    middleName: { type: String, trim: true, maxlength: 80, default: null },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: ['male', 'female', 'other', 'undisclosed'] },

    relationship: {
      type: String,
      required: true,
      enum: ['child', 'spouse', 'parent', 'sibling', 'ward', 'domestic-staff', 'driver', 'other'],
    },

    phone: { type: String, trim: true, default: null },
    phoneIndex: { type: String, default: null },

    nin: { type: encryptedFieldSchema, default: null },
    ninIndex: { type: String, default: null },
    ninLast4: { type: String, default: null },

    photoUrl: { type: String, default: null },
    schoolOrWorkplace: { type: String, trim: true, maxlength: 200, default: null },

    linkedMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },

    isActive: { type: Boolean, default: true },
    departedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

dependantSchema.index({ estateId: 1, guardianMembershipId: 1, isActive: 1 });
dependantSchema.index({ estateId: 1, propertyId: 1 });
dependantSchema.index({ estateId: 1, lastName: 1, firstName: 1 });

// A NIN identifies one person platform-wide, whether or not they hold an
// account, so the same uniqueness rule applies here as on `users`.
dependantSchema.index(
  { ninIndex: 1 },
  { unique: true, partialFilterExpression: { ninIndex: { $type: 'string' }, deletedAt: null } },
);

export const DependantModel: Model<DependantDoc> =
  (mongoose.models.Dependant as Model<DependantDoc>) ??
  mongoose.model<DependantDoc>('Dependant', dependantSchema);
