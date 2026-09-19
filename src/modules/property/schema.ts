import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A property within an estate.
 *
 * Modelled independently of the people in it, because the relationships change
 * while the property does not: owners sell, tenants move out, households grow.
 * Current occupancy is a pointer; the history is a separate, append-only record
 * so a dispute about who lived where in March is answerable.
 */
export type PropertyType =
  | 'detached'
  | 'semi-detached'
  | 'terrace'
  | 'duplex'
  | 'bungalow'
  | 'apartment'
  | 'studio'
  | 'shop'
  | 'office'
  | 'land'
  | 'other';

export type OccupancyStatus =
  'vacant' | 'owner-occupied' | 'tenant-occupied' | 'under-construction' | 'unavailable';

export interface PropertyDoc extends TenantDocument {
  /** House or unit number, unique within its estate. */
  unitNumber: string;
  block?: string | null;
  street: string;

  type: PropertyType;
  occupancyStatus: OccupancyStatus;

  /** Current owner. Null for an estate-owned or unassigned property. */
  ownerId?: Types.ObjectId | null;
  /** Current landlord, where distinct from the owner. */
  landlordId?: Types.ObjectId | null;

  bedrooms?: number | null;
  /** Occupant cap, used to flag overcrowding during tenant registration. */
  maxOccupants?: number | null;
  currentOccupantCount: number;

  /** Optional coordinates, for the future estate map. */
  location?: { lat: number; lng: number } | null;

  notes?: string | null;

  registeredAt: Date;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const propertySchema = new Schema<PropertyDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    unitNumber: { type: String, required: true, trim: true, maxlength: 20 },
    block: { type: String, trim: true, maxlength: 40, default: null },
    street: { type: String, required: true, trim: true, maxlength: 120 },

    type: {
      type: String,
      required: true,
      enum: [
        'detached',
        'semi-detached',
        'terrace',
        'duplex',
        'bungalow',
        'apartment',
        'studio',
        'shop',
        'office',
        'land',
        'other',
      ],
    },

    occupancyStatus: {
      type: String,
      enum: ['vacant', 'owner-occupied', 'tenant-occupied', 'under-construction', 'unavailable'],
      default: 'vacant',
    },

    ownerId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    landlordId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },

    bedrooms: { type: Number, default: null, min: 0, max: 50 },
    maxOccupants: { type: Number, default: null, min: 1, max: 100 },
    currentOccupantCount: { type: Number, default: 0, min: 0 },

    location: {
      type: new Schema(
        { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },

    notes: { type: String, trim: true, maxlength: 2000, default: null },

    registeredAt: { type: Date, default: Date.now },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Unit numbers are unique per estate. Soft-deleted rows are excluded so a unit
// number can be reused after a property is removed from the register.
propertySchema.index(
  { estateId: 1, unitNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
propertySchema.index({ estateId: 1, occupancyStatus: 1 });
propertySchema.index({ estateId: 1, ownerId: 1 });
propertySchema.index({ estateId: 1, street: 1, block: 1 });

export const PropertyModel: Model<PropertyDoc> =
  (mongoose.models.Property as Model<PropertyDoc>) ??
  mongoose.model<PropertyDoc>('Property', propertySchema);

/**
 * Append-only record of who held or occupied a property, and when.
 *
 * Separate from the property because it must survive the relationship ending.
 * When a tenant moves out the tenancy is closed, never deleted — gate logs,
 * invoices and incident reports from that period all point back here, and a
 * dispute six months later needs it to resolve.
 */
export type OccupancyRole = 'owner' | 'landlord' | 'tenant';

export interface PropertyOccupancyDoc extends TenantDocument {
  propertyId: Types.ObjectId;
  membershipId: Types.ObjectId;
  role: OccupancyRole;

  startedAt: Date;
  /** Null while current. Set on transfer, exit or termination. */
  endedAt?: Date | null;
  endReason?: 'transferred' | 'lease-ended' | 'evicted' | 'moved-out' | 'corrected' | null;

  /** Lease terms, for tenancies. */
  leaseStartDate?: Date | null;
  leaseEndDate?: Date | null;
  occupantCount?: number | null;

  recordedBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const occupancySchema = new Schema<PropertyOccupancyDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    propertyId: { type: Schema.Types.ObjectId, required: true, ref: 'Property' },
    membershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    role: { type: String, required: true, enum: ['owner', 'landlord', 'tenant'] },

    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: { type: Date, default: null },
    endReason: {
      type: String,
      enum: ['transferred', 'lease-ended', 'evicted', 'moved-out', 'corrected'],
      default: null,
    },

    leaseStartDate: { type: Date, default: null },
    leaseEndDate: { type: Date, default: null },
    occupantCount: { type: Number, default: null, min: 1 },

    recordedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

occupancySchema.index({ estateId: 1, propertyId: 1, endedAt: 1 });
occupancySchema.index({ estateId: 1, membershipId: 1, endedAt: 1 });
// Finds tenancies approaching expiry, for renewal reminders.
occupancySchema.index({ estateId: 1, role: 1, leaseEndDate: 1 });

// One current holder per role per property. Enforced by index rather than by
// application logic, so two concurrent transfers cannot both succeed.
occupancySchema.index(
  { estateId: 1, propertyId: 1, role: 1 },
  { unique: true, partialFilterExpression: { endedAt: null, deletedAt: null } },
);

export const PropertyOccupancyModel: Model<PropertyOccupancyDoc> =
  (mongoose.models.PropertyOccupancy as Model<PropertyOccupancyDoc>) ??
  mongoose.model<PropertyOccupancyDoc>(
    'PropertyOccupancy',
    occupancySchema,
    'property_occupancies',
  );
