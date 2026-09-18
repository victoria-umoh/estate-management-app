import mongoose, { Schema, type Model, type Types } from 'mongoose';

/**
 * The audit trail.
 *
 * APPEND ONLY. There is no update or delete path anywhere in the codebase, the
 * schema is frozen against modification by a pre-hook, and the deployment guide
 * instructs granting the application's database user insert and find rights on
 * this collection only. An administrator who can quietly erase evidence of what
 * they did is not an administrator anyone can audit.
 *
 * Not soft-deleted and not tenant-mutable: entries outlive the records they
 * describe, because a dispute about a departed tenant or a transferred property
 * is exactly when the trail matters most.
 */
export type AuditOutcome = 'success' | 'failure';

export interface AuditLogDoc {
  _id: Types.ObjectId;

  /** Estate the action affected. Null for platform-level actions. */
  estateId?: Types.ObjectId | null;

  /** Who acted. `system` for automation; null when unauthenticated. */
  actorId?: Types.ObjectId | null;
  actorLabel: string;
  actorRoles: string[];

  /** Dot-notation verb, e.g. `resident.approved`, `payment.refunded`. */
  action: string;
  resource: string;
  resourceId?: string | null;

  outcome: AuditOutcome;
  /** Present on failure — why it was refused. */
  reason?: string | null;

  /**
   * Field-level change record. Sensitive values are redacted before they reach
   * here, so the trail shows that a NIN changed without becoming a second
   * database of NINs.
   */
  changes?: Array<{ field: string; from: unknown; to: unknown }>;

  ip?: string | null;
  userAgent?: string | null;
  /** Ties the entry to the request, its logs and any jobs it spawned. */
  correlationId?: string | null;

  /** Optional capture point, for gate and emergency events. */
  location?: { lat: number; lng: number } | null;

  metadata?: Record<string, unknown>;

  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, default: null },

    actorId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    actorLabel: { type: String, required: true },
    actorRoles: { type: [String], default: [] },

    action: { type: String, required: true },
    resource: { type: String, required: true },
    resourceId: { type: String, default: null },

    outcome: { type: String, enum: ['success', 'failure'], default: 'success' },
    reason: { type: String, default: null },

    changes: {
      type: [
        new Schema(
          {
            field: { type: String, required: true },
            from: { type: Schema.Types.Mixed },
            to: { type: Schema.Types.Mixed },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },

    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    correlationId: { type: String, default: null },

    location: {
      type: new Schema(
        { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },

    metadata: { type: Schema.Types.Mixed },
  },
  // Only createdAt: an audit entry that could be "updated" would defeat itself.
  { timestamps: { createdAt: true, updatedAt: false } },
);

/**
 * Reject modification at the ODM layer.
 *
 * Belt and braces alongside the database grant: no code path in this repository
 * updates an audit entry, but a future contributor reaching for
 * `AuditLogModel.updateOne` should hit an error rather than succeed quietly.
 */
const BLOCKED = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

for (const operation of BLOCKED) {
  auditLogSchema.pre(operation, function blockMutation() {
    throw new Error(
      `Audit log entries are immutable: "${operation}" is not permitted on audit_logs.`,
    );
  });
}

auditLogSchema.index({ estateId: 1, createdAt: -1 });
auditLogSchema.index({ estateId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ estateId: 1, resource: 1, resourceId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ correlationId: 1 });

export const AuditLogModel: Model<AuditLogDoc> =
  (mongoose.models.AuditLog as Model<AuditLogDoc>) ??
  mongoose.model<AuditLogDoc>('AuditLog', auditLogSchema, 'audit_logs');
