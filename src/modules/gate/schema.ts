import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A physical gate.
 *
 * Estates have several — a main gate, a service gate, a pedestrian entrance —
 * and every movement records which one it happened at. Without that, "who is
 * inside" is answerable but "how did they get in" is not, which is the first
 * question asked after an incident.
 *
 * The `devices` array is the integration seam for RFID readers, ANPR cameras
 * and boom barriers. Nothing reads it yet; it exists so adding one later is a
 * configuration change rather than a schema migration.
 */
export type GateStatus = 'open' | 'closed' | 'maintenance';
export type GateDirection = 'both' | 'entry-only' | 'exit-only';

export interface GateDoc extends TenantDocument {
  name: string;
  /** Short identifier shown on the officer's screen, e.g. "MAIN". */
  code: string;

  description?: string | null;
  location?: { lat: number; lng: number } | null;

  status: GateStatus;
  direction: GateDirection;

  /**
   * Operating window, in the estate's timezone. Null means always open.
   * A pedestrian gate that closes at 10pm is a real arrangement, and an officer
   * needs the system to agree with the padlock.
   */
  opensAt?: string | null;
  closesAt?: string | null;

  /** Officers currently assigned. Advisory — any officer may work any gate. */
  assignedOfficerIds: Types.ObjectId[];

  /** Future hardware. Declared, not yet consumed. */
  devices: Array<{
    kind: 'qr-scanner' | 'rfid-reader' | 'anpr-camera' | 'boom-barrier' | 'intercom';
    identifier: string;
    status: 'active' | 'offline' | 'disabled';
  }>;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const gateSchema = new Schema<GateDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },

    description: { type: String, trim: true, maxlength: 400, default: null },
    location: {
      type: new Schema(
        { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },

    status: { type: String, enum: ['open', 'closed', 'maintenance'], default: 'open' },
    direction: {
      type: String,
      enum: ['both', 'entry-only', 'exit-only'],
      default: 'both',
    },

    opensAt: { type: String, default: null },
    closesAt: { type: String, default: null },

    assignedOfficerIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Membership' },

    devices: {
      type: [
        new Schema(
          {
            kind: {
              type: String,
              required: true,
              enum: ['qr-scanner', 'rfid-reader', 'anpr-camera', 'boom-barrier', 'intercom'],
            },
            identifier: { type: String, required: true },
            status: {
              type: String,
              enum: ['active', 'offline', 'disabled'],
              default: 'active',
            },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

gateSchema.index(
  { estateId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
gateSchema.index({ estateId: 1, status: 1 });

export const GateModel: Model<GateDoc> =
  (mongoose.models.Gate as Model<GateDoc>) ?? mongoose.model<GateDoc>('Gate', gateSchema);
