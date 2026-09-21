import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A vehicle registered to the estate.
 *
 * Plate numbers are stored normalised (uppercase, alphanumeric only) alongside
 * the display form, because the plate is what an officer types when a QR will
 * not scan — and they will type it in whatever spacing they see on the bumper.
 */
export type VehicleStatus =
  'pending' | 'active' | 'suspended' | 'blacklisted' | 'expired' | 'removed';

export type VehicleType = 'car' | 'suv' | 'bus' | 'truck' | 'motorcycle' | 'tricycle' | 'other';

export interface VehicleDoc extends TenantDocument {
  /** As displayed, e.g. "ABC-123-XY". */
  plateNumber: string;
  /** Uppercase alphanumeric, for lookup. Unique per estate. */
  plateNormalised: string;

  make: string;
  model: string;
  colour: string;
  year?: number | null;
  type: VehicleType;

  /** Membership the vehicle belongs to. */
  ownerMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  /** Named driver, where not the owner. */
  driverName?: string | null;
  driverPhone?: string | null;

  photoUrl?: string | null;
  documentIds: Types.ObjectId[];

  insuranceProvider?: string | null;
  insuranceExpiryDate?: Date | null;

  status: VehicleStatus;
  blacklistReason?: string | null;
  blacklistedAt?: Date | null;
  blacklistedBy?: Types.ObjectId | null;

  verifiedAt?: Date | null;
  verifiedBy?: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const vehicleSchema = new Schema<VehicleDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    plateNumber: { type: String, required: true, trim: true, maxlength: 20 },
    plateNormalised: { type: String, required: true, uppercase: true, maxlength: 20 },

    make: { type: String, required: true, trim: true, maxlength: 40 },
    model: { type: String, required: true, trim: true, maxlength: 40 },
    colour: { type: String, required: true, trim: true, maxlength: 30 },
    year: { type: Number, default: null, min: 1900, max: 2100 },
    type: {
      type: String,
      required: true,
      enum: ['car', 'suv', 'bus', 'truck', 'motorcycle', 'tricycle', 'other'],
      default: 'car',
    },

    ownerMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    driverName: { type: String, trim: true, maxlength: 80, default: null },
    driverPhone: { type: String, trim: true, maxlength: 20, default: null },

    photoUrl: { type: String, default: null },
    documentIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Document' },

    insuranceProvider: { type: String, trim: true, maxlength: 80, default: null },
    insuranceExpiryDate: { type: Date, default: null },

    status: {
      type: String,
      enum: ['pending', 'active', 'suspended', 'blacklisted', 'expired', 'removed'],
      default: 'pending',
    },
    blacklistReason: { type: String, trim: true, maxlength: 500, default: null },
    blacklistedAt: { type: Date, default: null },
    blacklistedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One registration per plate per estate.
vehicleSchema.index(
  { estateId: 1, plateNormalised: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
vehicleSchema.index({ estateId: 1, ownerMembershipId: 1, status: 1 });
vehicleSchema.index({ estateId: 1, status: 1 });
// Backs the gate's manual plate lookup when a QR will not scan.
vehicleSchema.index({ plateNormalised: 1, estateId: 1 });

export const VehicleModel: Model<VehicleDoc> =
  (mongoose.models.Vehicle as Model<VehicleDoc>) ??
  mongoose.model<VehicleDoc>('Vehicle', vehicleSchema);

/** Normalise a plate for storage and lookup. */
export function normalisePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
