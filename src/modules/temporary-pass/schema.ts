import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A temporary pass.
 *
 * A short-lived credential for someone who needs REPEATED access for a bounded
 * period: a contractor working for three days, a nurse visiting daily for a
 * fortnight, a tutor who comes on Tuesdays for a term.
 *
 * It sits between the two things the estate already had and is neither:
 *
 *  - unlike a visitor pass it is REUSABLE within its window — the holder comes
 *    and goes as often as the work requires, and each passage is logged rather
 *    than consuming the pass;
 *  - unlike a resident credential it EXPIRES — the window is the whole point,
 *    and a contractor whose pass still opens the gate a month after the job
 *    finished is precisely the failure this replaces.
 *
 * Because it is reusable, the record keeps a use count and a last-used stamp
 * rather than a terminal "used" state. A pass that is being used forty times a
 * day by a "three-day contractor" is a question worth being able to ask.
 */
export type TemporaryPassStatus =
  | 'active' // valid within its window
  | 'expired' // window closed
  | 'revoked'; // withdrawn early

export interface TemporaryPassDoc extends TenantDocument {
  /** Short human-readable code, for when a QR will not scan. */
  code: string;

  holderName: string;
  holderPhone?: string | null;
  /** Firm the holder works for, when there is one. */
  company?: string | null;
  purpose: string;

  /** Resident or office the holder is here for. */
  sponsorMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  vehiclePlate?: string | null;
  vehiclePlateNormalised?: string | null;

  validFrom: Date;
  validUntil: Date;

  status: TemporaryPassStatus;

  /** Links to the credential the gate actually verifies. */
  credentialId?: Types.ObjectId | null;

  /** Reusable within the window, so usage is counted rather than terminal. */
  useCount: number;
  lastUsedAt?: Date | null;
  lastGateId?: Types.ObjectId | null;
  /** Whether the holder is currently inside, from the last recorded passage. */
  inside: boolean;

  issuedBy: Types.ObjectId;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  notes?: string | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const temporaryPassSchema = new Schema<TemporaryPassDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    code: { type: String, required: true, uppercase: true, maxlength: 12 },

    holderName: { type: String, required: true, trim: true, maxlength: 120 },
    holderPhone: { type: String, trim: true, maxlength: 20, default: null },
    company: { type: String, trim: true, maxlength: 120, default: null },
    purpose: { type: String, required: true, trim: true, maxlength: 200 },

    sponsorMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    vehiclePlate: { type: String, trim: true, maxlength: 20, default: null },
    vehiclePlateNormalised: { type: String, uppercase: true, maxlength: 20, default: null },

    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },

    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },

    credentialId: { type: Schema.Types.ObjectId, default: null, ref: 'AccessCredential' },

    useCount: { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },
    lastGateId: { type: Schema.Types.ObjectId, default: null, ref: 'Gate' },
    inside: { type: Boolean, default: false },

    issuedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, trim: true, maxlength: 500, default: null },
    notes: { type: String, trim: true, maxlength: 1000, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// estateId leads every compound index: it is on every query the repository
// issues, so an index that does not lead with it cannot be used.
temporaryPassSchema.index(
  { estateId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
temporaryPassSchema.index({ estateId: 1, sponsorMembershipId: 1, createdAt: -1 });
// The expiry sweep, and the "who has a live pass right now" list.
temporaryPassSchema.index({ estateId: 1, status: 1, validUntil: 1 });
temporaryPassSchema.index({ estateId: 1, vehiclePlateNormalised: 1 });

export const TemporaryPassModel: Model<TemporaryPassDoc> =
  (mongoose.models.TemporaryPass as Model<TemporaryPassDoc>) ??
  mongoose.model<TemporaryPassDoc>('TemporaryPass', temporaryPassSchema, 'temporary_passes');
