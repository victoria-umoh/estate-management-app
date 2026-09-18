import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A user's membership of one estate.
 *
 * This is where a person becomes a resident, a landlord, a security officer or
 * a chairman — and it is per-estate, so the same account can hold different
 * roles in different estates without either leaking into the other.
 *
 * Splitting this from `users` is what makes the platform genuinely multi-estate:
 * global identity is verified once, while approval, category and roles are
 * decided by each estate independently.
 */
export type ResidentCategory =
  | 'homeowner'
  | 'landlord'
  | 'tenant'
  | 'dependant'
  | 'family-member'
  | 'domestic-staff'
  | 'estate-staff'
  | 'security-personnel'
  | 'contractor'
  | 'other';

export type MembershipStatus =
  | 'pending' // registered, not yet reviewed
  | 'awaiting-approval' // verification complete, awaiting an administrator
  | 'active'
  | 'suspended'
  | 'exited'; // tenant moved out; retained for history

export interface MembershipDoc extends TenantDocument {
  userId: Types.ObjectId;

  category: ResidentCategory;
  /** Role documents granting permissions within this estate. */
  roleIds: Types.ObjectId[];

  status: MembershipStatus;

  /** Estate-issued identifier, e.g. PGE-2026-00124. Unique per estate. */
  residentCode?: string | null;

  propertyId?: Types.ObjectId | null;
  /** The household head, for dependants and domestic staff. */
  guardianMembershipId?: Types.ObjectId | null;

  approvedAt?: Date | null;
  approvedBy?: Types.ObjectId | null;
  rejectionReason?: string | null;

  /** Retained after exit so gate history and disputes remain resolvable. */
  movedInAt?: Date | null;
  movedOutAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const membershipSchema = new Schema<MembershipDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    category: {
      type: String,
      required: true,
      enum: [
        'homeowner',
        'landlord',
        'tenant',
        'dependant',
        'family-member',
        'domestic-staff',
        'estate-staff',
        'security-personnel',
        'contractor',
        'other',
      ],
    },
    roleIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Role' },

    status: {
      type: String,
      enum: ['pending', 'awaiting-approval', 'active', 'suspended', 'exited'],
      default: 'pending',
    },

    residentCode: { type: String, default: null },

    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },
    guardianMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },

    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    rejectionReason: { type: String, default: null },

    movedInAt: { type: Date, default: null },
    movedOutAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Every index leads with estateId, matching how the tenant guard queries.
membershipSchema.index({ estateId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ estateId: 1, status: 1 });
membershipSchema.index({ estateId: 1, propertyId: 1 });
membershipSchema.index({ estateId: 1, category: 1, status: 1 });
membershipSchema.index(
  { estateId: 1, residentCode: 1 },
  { unique: true, partialFilterExpression: { residentCode: { $type: 'string' } } },
);

// Not tenant-scoped: used at login to answer "which estates is this user in?"
// before any estate context exists.
membershipSchema.index({ userId: 1, status: 1 });

export const MembershipModel: Model<MembershipDoc> =
  (mongoose.models.Membership as Model<MembershipDoc>) ??
  mongoose.model<MembershipDoc>('Membership', membershipSchema);
