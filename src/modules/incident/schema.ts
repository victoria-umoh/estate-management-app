import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * An incident: something that went wrong and needs a record.
 *
 * The status flow is deliberately linear with one branch — escalation — because
 * a workflow an officer cannot hold in their head while standing in the rain is
 * a workflow that gets bypassed. Anything more elaborate belongs in the notes.
 */
export type IncidentCategory =
  | 'theft'
  | 'security-breach'
  | 'suspicious-activity'
  | 'property-damage'
  | 'noise'
  | 'parking'
  | 'fire'
  | 'flood'
  | 'medical'
  | 'accident'
  | 'power'
  | 'water'
  | 'other';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type IncidentStatus =
  'open' | 'assigned' | 'investigating' | 'resolved' | 'closed' | 'escalated';

export interface IncidentDoc extends TenantDocument {
  /** Human-readable reference, quoted in conversation. */
  reference: string;

  category: IncidentCategory;
  severity: IncidentSeverity;
  /**
   * Numeric rank mirroring `severity`.
   *
   * Sorting on the string sorts alphabetically — "low" ahead of "critical" —
   * which would bury the incidents that matter most beneath noise complaints.
   * Kept in step by the service, never set by callers.
   */
  severityRank: number;
  title: string;
  description: string;

  reportedByMembershipId: Types.ObjectId;
  occurredAt: Date;

  /** Free text — "near the back gate", "block C car park". */
  location?: string | null;
  coordinates?: { lat: number; lng: number } | null;
  gateId?: Types.ObjectId | null;
  propertyId?: Types.ObjectId | null;

  /**
   * People and vehicles named in the report.
   *
   * Stored as free text alongside optional ids, because the reporter usually
   * does not know who someone was — "a man in a blue shirt" is the most
   * accurate thing they can say, and forcing a resident id would lose it.
   */
  involvedPersons: Array<{ label: string; membershipId?: Types.ObjectId | null }>;
  involvedVehicles: Array<{ plate: string; vehicleId?: Types.ObjectId | null }>;

  attachmentIds: Types.ObjectId[];

  status: IncidentStatus;

  assignedToMembershipId?: Types.ObjectId | null;
  assignedAt?: Date | null;

  resolution?: string | null;
  resolvedAt?: Date | null;
  resolvedByMembershipId?: Types.ObjectId | null;

  escalatedAt?: Date | null;
  escalationReason?: string | null;

  closedAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const incidentSchema = new Schema<IncidentDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    reference: { type: String, required: true, uppercase: true, maxlength: 20 },

    category: {
      type: String,
      required: true,
      enum: [
        'theft',
        'security-breach',
        'suspicious-activity',
        'property-damage',
        'noise',
        'parking',
        'fire',
        'flood',
        'medical',
        'accident',
        'power',
        'water',
        'other',
      ],
    },
    severity: {
      type: String,
      required: true,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    severityRank: { type: Number, required: true, default: 2 },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },

    reportedByMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    occurredAt: { type: Date, required: true, default: Date.now },

    location: { type: String, trim: true, maxlength: 200, default: null },
    coordinates: {
      type: new Schema(
        { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },
    gateId: { type: Schema.Types.ObjectId, default: null, ref: 'Gate' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    involvedPersons: {
      type: [
        new Schema(
          {
            label: { type: String, required: true, maxlength: 160 },
            membershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    involvedVehicles: {
      type: [
        new Schema(
          {
            plate: { type: String, required: true, uppercase: true, maxlength: 20 },
            vehicleId: { type: Schema.Types.ObjectId, default: null, ref: 'Vehicle' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    attachmentIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Document' },

    status: {
      type: String,
      enum: ['open', 'assigned', 'investigating', 'resolved', 'closed', 'escalated'],
      default: 'open',
    },

    assignedToMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    assignedAt: { type: Date, default: null },

    resolution: { type: String, trim: true, maxlength: 5000, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedByMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },

    escalatedAt: { type: Date, default: null },
    escalationReason: { type: String, trim: true, maxlength: 1000, default: null },

    closedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

incidentSchema.index(
  { estateId: 1, reference: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
incidentSchema.index({ estateId: 1, status: 1, severityRank: -1, createdAt: -1 });
incidentSchema.index({ estateId: 1, assignedToMembershipId: 1, status: 1 });
incidentSchema.index({ estateId: 1, reportedByMembershipId: 1, createdAt: -1 });
incidentSchema.index({ estateId: 1, category: 1, occurredAt: -1 });

/** Severity to rank. The only place the mapping is defined. */
export const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const IncidentModel: Model<IncidentDoc> =
  (mongoose.models.Incident as Model<IncidentDoc>) ??
  mongoose.model<IncidentDoc>('Incident', incidentSchema);

/**
 * A comment on an incident.
 *
 * Separate collection rather than an embedded array: an active investigation
 * accumulates comments indefinitely, and an unbounded array on a hot document
 * eventually stops fitting.
 */
export interface IncidentCommentDoc extends TenantDocument {
  incidentId: Types.ObjectId;
  authorMembershipId: Types.ObjectId;
  body: string;
  /** Visible only to staff. Used for investigation notes. */
  internal: boolean;
  attachmentIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const incidentCommentSchema = new Schema<IncidentCommentDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    incidentId: { type: Schema.Types.ObjectId, required: true, ref: 'Incident' },
    authorMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    internal: { type: Boolean, default: false },
    attachmentIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Document' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

incidentCommentSchema.index({ estateId: 1, incidentId: 1, createdAt: 1 });

export const IncidentCommentModel: Model<IncidentCommentDoc> =
  (mongoose.models.IncidentComment as Model<IncidentCommentDoc>) ??
  mongoose.model<IncidentCommentDoc>('IncidentComment', incidentCommentSchema, 'incident_comments');
