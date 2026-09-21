import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * An emergency: someone pressed the button.
 *
 * Almost every field is optional by design. This record is created by a person
 * in trouble, possibly one-handed, possibly for someone else, and the only
 * thing that must not happen is the save failing because a field was missing.
 * Detail can be added afterwards; the alert cannot be sent afterwards.
 *
 * `responseTimeSeconds` is stored rather than derived, because it is the number
 * an estate will be judged on and it should not change if a timestamp is later
 * corrected.
 */
export type EmergencyType = 'medical' | 'fire' | 'security' | 'police' | 'accident' | 'other';

export type EmergencyStatus =
  'triggered' | 'acknowledged' | 'responding' | 'resolved' | 'false-alarm';

export interface EmergencyDoc extends TenantDocument {
  reference: string;

  type: EmergencyType;

  triggeredByMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  /** Whatever the caller could give. All optional. */
  description?: string | null;
  location?: string | null;
  coordinates?: { lat: number; lng: number } | null;
  contactPhone?: string | null;

  status: EmergencyStatus;

  acknowledgedAt?: Date | null;
  acknowledgedByMembershipId?: Types.ObjectId | null;
  /** Seconds from trigger to acknowledgement. The headline metric. */
  responseTimeSeconds?: number | null;

  respondingAt?: Date | null;
  resolvedAt?: Date | null;
  resolvedByMembershipId?: Types.ObjectId | null;
  outcome?: string | null;

  /** Responders notified, for the after-action record. */
  notifiedMembershipIds: Types.ObjectId[];

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const emergencySchema = new Schema<EmergencyDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    reference: { type: String, required: true, uppercase: true, maxlength: 20 },

    type: {
      type: String,
      required: true,
      enum: ['medical', 'fire', 'security', 'police', 'accident', 'other'],
    },

    triggeredByMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    description: { type: String, trim: true, maxlength: 2000, default: null },
    location: { type: String, trim: true, maxlength: 200, default: null },
    coordinates: {
      type: new Schema(
        { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },
    contactPhone: { type: String, trim: true, maxlength: 20, default: null },

    status: {
      type: String,
      enum: ['triggered', 'acknowledged', 'responding', 'resolved', 'false-alarm'],
      default: 'triggered',
    },

    acknowledgedAt: { type: Date, default: null },
    acknowledgedByMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    responseTimeSeconds: { type: Number, default: null },

    respondingAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedByMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    outcome: { type: String, trim: true, maxlength: 2000, default: null },

    notifiedMembershipIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Membership' },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emergencySchema.index(
  { estateId: 1, reference: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
// The security dashboard's most urgent query: anything not yet resolved.
emergencySchema.index({ estateId: 1, status: 1, createdAt: -1 });
emergencySchema.index({ estateId: 1, triggeredByMembershipId: 1, createdAt: -1 });

export const EmergencyModel: Model<EmergencyDoc> =
  (mongoose.models.Emergency as Model<EmergencyDoc>) ??
  mongoose.model<EmergencyDoc>('Emergency', emergencySchema);
