import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * An exit (removal) pass.
 *
 * Authorises taking goods OUT of the estate. Estates are not usually robbed by
 * people breaking in; they are robbed by people walking out of the front gate
 * carrying something, confidently, while an officer who has no way to know what
 * should be leaving waves them through. The manifest and the approval are the
 * whole point of this record: they give the officer at the barrier something to
 * check the load against, and they give the household a name against the
 * removal afterwards.
 *
 * Unlike a visitor pass this is single-use. It closes the moment the goods
 * leave, because a pass that still works after the sofa is gone is a pass that
 * authorises the second sofa.
 */
export type ExitPassStatus =
  | 'pending' // awaiting approval
  | 'approved' // valid at the gate
  | 'rejected' // refused by an approver
  | 'used' // goods left; spent
  | 'expired' // window closed unused
  | 'cancelled'; // withdrawn by the requester

/**
 * One line of the manifest.
 *
 * `identifyingMark` is a serial number, an engraving, a colour — whatever lets
 * "1 television" be distinguished from a different television later.
 */
export interface ExitPassItem {
  quantity: number;
  description: string;
  identifyingMark?: string | null;
  /** Integer minor units (kobo). */
  estimatedValue?: number | null;
}

export interface ExitPassDoc extends TenantDocument {
  /** Short human-readable code, for when a QR will not scan. */
  code: string;

  /** Household the goods are leaving from. */
  requestedByMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  /** Who is physically carrying the goods out — often not the resident. */
  carrierName: string;
  carrierPhone?: string | null;

  /** Where the goods are going, and why. Both are read out in a dispute. */
  destination: string;
  reason: string;

  vehiclePlate?: string | null;
  vehiclePlateNormalised?: string | null;

  items: ExitPassItem[];

  validFrom: Date;
  validUntil: Date;

  status: ExitPassStatus;

  /**
   * Whether this pass needed an approver, captured at creation.
   *
   * Snapshotted rather than read from the estate at verification time: an
   * estate that turns approval off next month must not retroactively make an
   * unapproved removal look authorised.
   */
  approvalRequired: boolean;

  approvedBy?: Types.ObjectId | null;
  approvedAt?: Date | null;
  decisionReason?: string | null;

  /**
   * When the manifest stopped being editable.
   *
   * Set at the moment the pass becomes valid at the gate (approval, or creation
   * when the estate does not require approval). After this the manifest is
   * evidence, and evidence that the person being checked can still edit is not
   * evidence — same reasoning as the ledger's immutability. The service refuses
   * edits once it is set; this field exists so the refusal has a reason and a
   * timestamp rather than being inferred from the status.
   */
  manifestLockedAt?: Date | null;

  /** Links to the credential the gate actually verifies. */
  credentialId?: Types.ObjectId | null;

  usedAt?: Date | null;
  usedGateId?: Types.ObjectId | null;
  usedBy?: Types.ObjectId | null;

  createdBy: Types.ObjectId;
  notes?: string | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const exitPassItemSchema = new Schema<ExitPassItem>(
  {
    quantity: { type: Number, required: true, min: 1, max: 10_000 },
    description: { type: String, required: true, trim: true, maxlength: 200 },
    identifyingMark: { type: String, trim: true, maxlength: 120, default: null },
    estimatedValue: { type: Number, min: 0, default: null },
  },
  { _id: false },
);

const exitPassSchema = new Schema<ExitPassDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    code: { type: String, required: true, uppercase: true, maxlength: 12 },

    requestedByMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    carrierName: { type: String, required: true, trim: true, maxlength: 120 },
    carrierPhone: { type: String, trim: true, maxlength: 20, default: null },

    destination: { type: String, required: true, trim: true, maxlength: 200 },
    reason: { type: String, required: true, trim: true, maxlength: 200 },

    vehiclePlate: { type: String, trim: true, maxlength: 20, default: null },
    vehiclePlateNormalised: { type: String, uppercase: true, maxlength: 20, default: null },

    items: { type: [exitPassItemSchema], required: true, default: [] },

    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'used', 'expired', 'cancelled'],
      default: 'pending',
    },

    approvalRequired: { type: Boolean, required: true, default: true },

    approvedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    approvedAt: { type: Date, default: null },
    decisionReason: { type: String, trim: true, maxlength: 500, default: null },

    manifestLockedAt: { type: Date, default: null },

    credentialId: { type: Schema.Types.ObjectId, default: null, ref: 'AccessCredential' },

    usedAt: { type: Date, default: null },
    usedGateId: { type: Schema.Types.ObjectId, default: null, ref: 'Gate' },
    usedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    createdBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    notes: { type: String, trim: true, maxlength: 1000, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Every compound index leads with estateId: it is the highest-selectivity field
// in a multi-tenant collection and it is present on literally every query the
// repository issues, so an index that does not lead with it cannot be used.
exitPassSchema.index(
  { estateId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
exitPassSchema.index({ estateId: 1, requestedByMembershipId: 1, createdAt: -1 });
// The approvals queue, which is what an estate manager opens each morning.
exitPassSchema.index({ estateId: 1, status: 1, createdAt: -1 });
// The expiry sweep: approved-but-unused passes past their window.
exitPassSchema.index({ estateId: 1, status: 1, validUntil: 1 });

export const ExitPassModel: Model<ExitPassDoc> =
  (mongoose.models.ExitPass as Model<ExitPassDoc>) ??
  mongoose.model<ExitPassDoc>('ExitPass', exitPassSchema, 'exit_passes');
