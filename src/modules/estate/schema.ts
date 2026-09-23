import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * An estate.
 *
 * The tenant root. Every other tenant-scoped document carries this document's
 * `_id` as its `estateId`, so this is the one collection that is NOT itself
 * tenant-scoped — it defines the boundary rather than sitting inside one.
 */
export type EstateStatus = 'trial' | 'active' | 'past-due' | 'suspended' | 'closed';

export interface EstateDoc {
  _id: Types.ObjectId;

  name: string;
  /** URL-safe identifier, unique platform-wide. */
  slug: string;

  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    country: string;
    postalCode?: string;
  };

  contact: {
    email: string;
    phone: string;
    website?: string;
  };

  logoUrl?: string | null;

  status: EstateStatus;

  /**
   * Operational settings, configurable per estate.
   *
   * Held on the estate rather than in code so a chairman can adjust the grace
   * period or approval requirements without a deploy.
   */
  settings: {
    /** Minutes past expected departure before a visitor is flagged. */
    visitorOverstayGraceMinutes: number;
    /** Maximum days a visitor pass may be valid for. */
    visitorPassMaxDurationDays: number;
    /** Require an administrator to approve each new resident. */
    requireResidentApproval: boolean;
    /** Require a successful NIN check before approval. */
    requireNinVerification: boolean;
    /** Require approval before an exit pass is valid at the gate. */
    requireExitPassApproval: boolean;
    /**
     * Maximum days a temporary pass may be valid for.
     *
     * The bound is the point of a temporary pass. Thirty days by default —
     * long enough for a renovation, short enough that a contractor who
     * finished in March is not still opening the gate in June.
     */
    temporaryPassMaxDurationDays: number;
    /** Allow a landlord to register tenants directly. */
    allowLandlordTenantRegistration: boolean;
    /** Days before expiry that an ID card is flagged for renewal. */
    idCardExpiryWarningDays: number;
    /** Currency for all billing in this estate. */
    currency: string;
    timezone: string;
  };

  /** Paystack subaccount, so resident dues settle to the estate. */
  paystackSubaccountCode?: string | null;

  /** Denormalised counters, maintained by domain events. */
  stats: {
    propertyCount: number;
    residentCount: number;
    vehicleCount: number;
  };

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const estateSchema = new Schema<EstateDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true },

    address: {
      line1: { type: String, required: true, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      country: { type: String, required: true, trim: true, default: 'Nigeria' },
      postalCode: { type: String, trim: true },
    },

    contact: {
      email: { type: String, required: true, lowercase: true, trim: true },
      phone: { type: String, required: true, trim: true },
      website: { type: String, trim: true },
    },

    logoUrl: { type: String, default: null },

    status: {
      type: String,
      enum: ['trial', 'active', 'past-due', 'suspended', 'closed'],
      default: 'trial',
      index: true,
    },

    settings: {
      visitorOverstayGraceMinutes: { type: Number, default: 60, min: 0, max: 1440 },
      visitorPassMaxDurationDays: { type: Number, default: 7, min: 1, max: 90 },
      requireResidentApproval: { type: Boolean, default: true },
      requireNinVerification: { type: Boolean, default: true },
      requireExitPassApproval: { type: Boolean, default: true },
      temporaryPassMaxDurationDays: { type: Number, default: 30, min: 1, max: 365 },
      allowLandlordTenantRegistration: { type: Boolean, default: true },
      idCardExpiryWarningDays: { type: Number, default: 30, min: 1, max: 365 },
      currency: { type: String, default: 'NGN' },
      timezone: { type: String, default: 'Africa/Lagos' },
    },

    paystackSubaccountCode: { type: String, default: null },

    stats: {
      propertyCount: { type: Number, default: 0 },
      residentCount: { type: Number, default: 0 },
      vehicleCount: { type: Number, default: 0 },
    },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

estateSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

export const EstateModel: Model<EstateDoc> =
  (mongoose.models.Estate as Model<EstateDoc>) ?? mongoose.model<EstateDoc>('Estate', estateSchema);
