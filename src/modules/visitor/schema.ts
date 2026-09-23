import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A visitor pass.
 *
 * Two kinds share this collection, distinguished by `passType`:
 *
 *  - `expected` — created in advance by a resident, who sends the code to their
 *    guest.
 *  - `walk-in` — issued at the gate by an officer for someone who arrived
 *    unannounced and was approved on the spot. Deliveries, contractors,
 *    relatives who did not call ahead.
 *
 * They behave identically once issued, so keeping them together means the gate,
 * the overstay sweep and the reports each handle one shape rather than two.
 * What differs is who created it and whether a host approved it, and both are
 * recorded.
 */
export type VisitorPassType = 'expected' | 'walk-in';

export type VisitorPassStatus =
  | 'pending' // created, not yet arrived
  | 'inside' // checked in, currently in the estate
  | 'completed' // checked out normally
  | 'expired' // window closed without arrival
  | 'cancelled' // withdrawn by the host
  | 'denied'; // refused at the gate

export interface VisitorPassDoc extends TenantDocument {
  passType: VisitorPassType;

  /** Short human-readable code, for when a QR will not scan. */
  code: string;

  /** Resident being visited. */
  hostMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  visitorName: string;
  visitorPhone?: string | null;
  /** Number in the party, including the named visitor. */
  partySize: number;
  purpose: string;

  vehiclePlate?: string | null;
  vehiclePlateNormalised?: string | null;

  expectedArrival: Date;
  expectedDeparture: Date;

  status: VisitorPassStatus;

  /** Links to the credential the gate actually verifies. */
  credentialId?: Types.ObjectId | null;

  checkedInAt?: Date | null;
  checkedInGateId?: Types.ObjectId | null;
  checkedInBy?: Types.ObjectId | null;

  checkedOutAt?: Date | null;
  checkedOutGateId?: Types.ObjectId | null;
  checkedOutBy?: Types.ObjectId | null;

  /**
   * Set when the overstay sweep has raised this pass, so the host and security
   * are told once rather than every time the job runs.
   */
  overstayNotifiedAt?: Date | null;

  /** Officer who issued a walk-in pass. */
  issuedBy: Types.ObjectId;
  /** Whether a host actually approved a walk-in, or the officer vouched. */
  hostApproved: boolean;

  denialReason?: string | null;
  notes?: string | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const visitorPassSchema = new Schema<VisitorPassDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    passType: { type: String, required: true, enum: ['expected', 'walk-in'], default: 'expected' },

    code: { type: String, required: true, uppercase: true, maxlength: 12 },

    hostMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    visitorName: { type: String, required: true, trim: true, maxlength: 120 },
    visitorPhone: { type: String, trim: true, maxlength: 20, default: null },
    partySize: { type: Number, default: 1, min: 1, max: 100 },
    purpose: { type: String, required: true, trim: true, maxlength: 200 },

    vehiclePlate: { type: String, trim: true, maxlength: 20, default: null },
    vehiclePlateNormalised: { type: String, uppercase: true, maxlength: 20, default: null },

    expectedArrival: { type: Date, required: true },
    expectedDeparture: { type: Date, required: true },

    status: {
      type: String,
      enum: ['pending', 'inside', 'completed', 'expired', 'cancelled', 'denied'],
      default: 'pending',
    },

    credentialId: { type: Schema.Types.ObjectId, default: null, ref: 'AccessCredential' },

    checkedInAt: { type: Date, default: null },
    checkedInGateId: { type: Schema.Types.ObjectId, default: null, ref: 'Gate' },
    checkedInBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    checkedOutAt: { type: Date, default: null },
    checkedOutGateId: { type: Schema.Types.ObjectId, default: null, ref: 'Gate' },
    checkedOutBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    overstayNotifiedAt: { type: Date, default: null },

    issuedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    hostApproved: { type: Boolean, default: true },

    denialReason: { type: String, trim: true, maxlength: 500, default: null },
    notes: { type: String, trim: true, maxlength: 1000, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

visitorPassSchema.index(
  { estateId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
visitorPassSchema.index({ estateId: 1, hostMembershipId: 1, createdAt: -1 });
// The resident's own list, ordered by when the visit is expected rather than
// when the pass was created — which is the ordering that screen uses.
visitorPassSchema.index({ estateId: 1, hostMembershipId: 1, expectedArrival: -1 });
visitorPassSchema.index({ estateId: 1, status: 1, expectedArrival: 1 });
visitorPassSchema.index({ estateId: 1, vehiclePlateNormalised: 1 });

/**
 * The overstay sweep's index.
 *
 * Finds passes still inside whose departure time has passed and which have not
 * yet been raised. Compound and ordered so the sweep is a range scan rather
 * than a pass over every visitor who ever came.
 */
visitorPassSchema.index({ status: 1, expectedDeparture: 1, overstayNotifiedAt: 1 });

export const VisitorPassModel: Model<VisitorPassDoc> =
  (mongoose.models.VisitorPass as Model<VisitorPassDoc>) ??
  mongoose.model<VisitorPassDoc>('VisitorPass', visitorPassSchema, 'visitor_passes');
