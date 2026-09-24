import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A service request: a resident asking the estate to fix something.
 *
 * Carries an SLA target (`dueAt`) computed from priority at creation, so
 * "overdue" is answerable by a query rather than by recomputing the rule for
 * every row — and so a later change to the SLA policy does not silently
 * re-date tickets that were raised under the old one.
 */
export type ServiceCategory =
  | 'security'
  | 'water'
  | 'electricity'
  | 'waste'
  | 'roads'
  | 'drainage'
  | 'streetlight'
  | 'maintenance'
  | 'noise'
  | 'other';

export type ServicePriority = 'low' | 'normal' | 'high' | 'urgent';

export type ServiceStatus =
  'open' | 'assigned' | 'in-progress' | 'awaiting-resident' | 'resolved' | 'closed';

export interface ServiceRequestDoc extends TenantDocument {
  ticketNumber: string;

  category: ServiceCategory;
  priority: ServicePriority;
  subject: string;
  description: string;

  requestedByMembershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;
  location?: string | null;

  attachmentIds: Types.ObjectId[];

  status: ServiceStatus;

  assignedToMembershipId?: Types.ObjectId | null;
  assignedDepartment?: string | null;
  assignedAt?: Date | null;

  /** SLA target, fixed at creation from the priority then in force. */
  dueAt: Date;
  escalatedAt?: Date | null;

  resolution?: string | null;
  resolvedAt?: Date | null;
  resolvedByMembershipId?: Types.ObjectId | null;
  closedAt?: Date | null;

  /** Resident's rating once closed, for the service report. */
  satisfactionRating?: number | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const serviceRequestSchema = new Schema<ServiceRequestDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    ticketNumber: { type: String, required: true, uppercase: true, maxlength: 20 },

    category: {
      type: String,
      required: true,
      enum: [
        'security',
        'water',
        'electricity',
        'waste',
        'roads',
        'drainage',
        'streetlight',
        'maintenance',
        'noise',
        'other',
      ],
    },
    priority: {
      type: String,
      required: true,
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal',
    },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },

    requestedByMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },
    location: { type: String, trim: true, maxlength: 200, default: null },

    attachmentIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Document' },

    status: {
      type: String,
      enum: ['open', 'assigned', 'in-progress', 'awaiting-resident', 'resolved', 'closed'],
      default: 'open',
    },

    assignedToMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    assignedDepartment: { type: String, trim: true, maxlength: 80, default: null },
    assignedAt: { type: Date, default: null },

    dueAt: { type: Date, required: true },
    escalatedAt: { type: Date, default: null },

    resolution: { type: String, trim: true, maxlength: 5000, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedByMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    closedAt: { type: Date, default: null },

    satisfactionRating: { type: Number, default: null, min: 1, max: 5 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

serviceRequestSchema.index(
  { estateId: 1, ticketNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
serviceRequestSchema.index({ estateId: 1, status: 1, dueAt: 1 });
serviceRequestSchema.index({ estateId: 1, requestedByMembershipId: 1, createdAt: -1 });
serviceRequestSchema.index({ estateId: 1, assignedToMembershipId: 1, status: 1 });
// Backs the escalation sweep: open tickets past their target, not yet escalated.
serviceRequestSchema.index({ status: 1, dueAt: 1, escalatedAt: 1 });

export const ServiceRequestModel: Model<ServiceRequestDoc> =
  (mongoose.models.ServiceRequest as Model<ServiceRequestDoc>) ??
  mongoose.model<ServiceRequestDoc>('ServiceRequest', serviceRequestSchema, 'service_requests');

/**
 * A comment on a service request.
 *
 * The same shape and the same visibility rule as incident comments, on purpose:
 * an internal note is for staff, and a resident marking their own comment
 * internal would hide it from the very people fixing their problem. Two
 * conventions for "who can see this note" would be one convention too many.
 */
export interface ServiceRequestCommentDoc extends TenantDocument {
  serviceRequestId: Types.ObjectId;
  authorMembershipId: Types.ObjectId;
  body: string;
  /** Visible only to staff. Used for work notes. */
  internal: boolean;
  attachmentIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const serviceRequestCommentSchema = new Schema<ServiceRequestCommentDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    serviceRequestId: { type: Schema.Types.ObjectId, required: true, ref: 'ServiceRequest' },
    authorMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    internal: { type: Boolean, default: false },
    attachmentIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Document' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

serviceRequestCommentSchema.index({ estateId: 1, serviceRequestId: 1, createdAt: 1 });

export const ServiceRequestCommentModel: Model<ServiceRequestCommentDoc> =
  (mongoose.models.ServiceRequestComment as Model<ServiceRequestCommentDoc>) ??
  mongoose.model<ServiceRequestCommentDoc>(
    'ServiceRequestComment',
    serviceRequestCommentSchema,
    'service_request_comments',
  );
