import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * Every gate event: admitted, denied, entry, exit.
 *
 * Append-only in practice — nothing in the codebase updates a movement after it
 * is written. This is the record consulted after a theft, a dispute or a
 * missing child, and a log that can be quietly amended is not evidence.
 *
 * Denials are recorded as deliberately as admissions. A refused scan is the
 * more interesting event: a pattern of them at 3am is the signal worth having.
 */
export type MovementDirection = 'in' | 'out';

export type MovementSubject = 'resident' | 'vehicle' | 'visitor' | 'exit-pass' | 'temporary-pass';

export type VerificationMethod =
  | 'qr' // scanned the pass
  | 'code' // typed the short code
  | 'plate' // looked up by plate
  | 'manual' // officer identified the person directly
  | 'device'; // RFID, ANPR or similar

export interface MovementDoc extends TenantDocument {
  gateId: Types.ObjectId;
  /** Officer who recorded it. */
  officerId: Types.ObjectId;

  direction: MovementDirection;
  subject: MovementSubject;
  subjectId?: Types.ObjectId | null;
  credentialId?: Types.ObjectId | null;

  /**
   * Denormalised label, captured at the moment of the event.
   *
   * Deliberately a copy: if a visitor pass is later deleted or a resident
   * leaves the estate, the log must still say who passed through. A log that
   * resolves to "unknown" once the source record changes is no use at all.
   */
  subjectLabel: string;
  unitNumber?: string | null;
  vehiclePlate?: string | null;

  admitted: boolean;
  denialReason?: string | null;

  method: VerificationMethod;

  partySize?: number | null;
  notes?: string | null;

  /** Optional capture point, for the future map view. */
  location?: { lat: number; lng: number } | null;
  deviceInfo?: string | null;

  occurredAt: Date;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const movementSchema = new Schema<MovementDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    gateId: { type: Schema.Types.ObjectId, required: true, ref: 'Gate' },
    officerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    direction: { type: String, required: true, enum: ['in', 'out'] },
    subject: {
      type: String,
      required: true,
      enum: ['resident', 'vehicle', 'visitor', 'exit-pass', 'temporary-pass'],
    },
    subjectId: { type: Schema.Types.ObjectId, default: null },
    credentialId: { type: Schema.Types.ObjectId, default: null, ref: 'AccessCredential' },

    subjectLabel: { type: String, required: true, maxlength: 160 },
    unitNumber: { type: String, default: null, maxlength: 20 },
    vehiclePlate: { type: String, default: null, maxlength: 20 },

    admitted: { type: Boolean, required: true },
    denialReason: { type: String, default: null, maxlength: 120 },

    method: {
      type: String,
      required: true,
      enum: ['qr', 'code', 'plate', 'manual', 'device'],
    },

    partySize: { type: Number, default: null, min: 1 },
    notes: { type: String, trim: true, maxlength: 1000, default: null },

    location: {
      type: new Schema(
        { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },
    deviceInfo: { type: String, default: null, maxlength: 200 },

    occurredAt: { type: Date, required: true, default: Date.now },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * Reject modification at the ODM layer, as for the audit log.
 *
 * No code path here updates a movement. A future contributor reaching for
 * `MovementModel.updateOne` should hit an error rather than succeed quietly.
 */
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteMany'] as const) {
  movementSchema.pre(operation, function blockMutation() {
    throw new Error(`Movement records are immutable: "${operation}" is not permitted.`);
  });
}

// The security dashboard's primary query: recent activity, newest first.
movementSchema.index({ estateId: 1, occurredAt: -1 });
movementSchema.index({ estateId: 1, gateId: 1, occurredAt: -1 });
movementSchema.index({ estateId: 1, subject: 1, subjectId: 1, occurredAt: -1 });
// Denied entries, which is what a supervisor reviews at shift change.
movementSchema.index({ estateId: 1, admitted: 1, occurredAt: -1 });

export const MovementModel: Model<MovementDoc> =
  (mongoose.models.Movement as Model<MovementDoc>) ??
  mongoose.model<MovementDoc>('Movement', movementSchema, 'movements');
