import mongoose, { Schema, type Model } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * A role within one estate.
 *
 * Roles are tenant-scoped: each estate gets its own copy of the system roles at
 * setup, so a chairman can inspect exactly what their security officers can do
 * without that inspection touching another estate.
 *
 * System roles are protected from edit and deletion. A chairman who accidentally
 * stripped `gate.operate` from the security officer role would lock their own
 * gates, and the failure would look like a hardware fault rather than a
 * permission change.
 */
export interface RoleDoc extends TenantDocument {
  /** Stable identifier, e.g. `security-officer`. Unique per estate. */
  code: string;
  name: string;
  description?: string;

  /** Permission strings. `*` is the super-admin wildcard. */
  permissions: string[];

  /** True for seeded roles, which cannot be edited or deleted. */
  isSystem: boolean;

  /**
   * Authority ranking. A user may not grant a role ranked at or above their own
   * highest, which stops a manager promoting themselves to chairman.
   */
  rank: number;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const roleSchema = new Schema<RoleDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 400 },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    rank: { type: Number, default: 10, min: 0, max: 100 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

roleSchema.index({ estateId: 1, code: 1 }, { unique: true });
roleSchema.index({ estateId: 1, isSystem: 1 });

export const RoleModel: Model<RoleDoc> =
  (mongoose.models.Role as Model<RoleDoc>) ?? mongoose.model<RoleDoc>('Role', roleSchema);
