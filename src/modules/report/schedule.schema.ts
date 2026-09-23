import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';
import type { ReportType } from './types';

/**
 * A standing instruction to run a report and email it.
 *
 * The owner is recorded and carried into the audit entry on every run. A
 * scheduled export under `systemContext` would be audited as "system", which
 * answers the wrong question — the interesting fact is not that a job ran, it is
 * which person arranged for an estate's data to be emailed out every month.
 *
 * The owner's permissions are also re-checked at each run rather than captured
 * at creation. Someone who leaves the finance committee should stop receiving
 * the collections report, and a schedule that outlived its author's authority is
 * the quiet version of a standing data leak.
 */
export type ScheduleCadence = 'daily' | 'weekly' | 'monthly';

export interface ReportScheduleDoc extends TenantDocument {
  reportType: ReportType;
  tableId: string;

  cadence: ScheduleCadence;
  /** 0–6, Sunday first. Weekly only. */
  dayOfWeek?: number | null;
  /** 1–28. Monthly only — 28 so every month has one. */
  dayOfMonth?: number | null;
  /** 0–23, in the estate's timezone. */
  hour: number;

  /** Plain addresses: a recipient need not be a member of the estate. */
  recipients: string[];

  /** Who arranged this, and whose permissions are re-checked at each run. */
  ownerMembershipId: Types.ObjectId;
  ownerUserId: Types.ObjectId;

  active: boolean;

  lastRunAt?: Date | null;
  lastRunStatus?: 'sent' | 'skipped' | 'failed' | null;
  lastRunDetail?: string | null;
  nextRunAt: Date;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const reportScheduleSchema = new Schema<ReportScheduleDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    reportType: {
      type: String,
      required: true,
      enum: ['collections', 'gate-activity', 'residents', 'incidents', 'visitors'],
    },
    tableId: { type: String, required: true, trim: true, maxlength: 60 },

    cadence: { type: String, required: true, enum: ['daily', 'weekly', 'monthly'] },
    dayOfWeek: { type: Number, default: null, min: 0, max: 6 },
    dayOfMonth: { type: Number, default: null, min: 1, max: 28 },
    hour: { type: Number, required: true, min: 0, max: 23, default: 7 },

    recipients: {
      type: [String],
      required: true,
      // Bounded: a schedule is a recurring send, so a long list is a recurring
      // cost and a wider disclosure every month rather than once.
      validate: [
        (value: string[]) => value.length > 0 && value.length <= 20,
        'A schedule needs between one and twenty recipients.',
      ],
    },

    ownerMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    ownerUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    active: { type: Boolean, default: true },

    lastRunAt: { type: Date, default: null },
    lastRunStatus: { type: String, enum: ['sent', 'skipped', 'failed'], default: null },
    lastRunDetail: { type: String, default: null, maxlength: 500 },
    nextRunAt: { type: Date, required: true },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reportScheduleSchema.index({ estateId: 1, active: 1, reportType: 1 });
// The sweep's own query, which runs across every estate. Partial, so inactive
// and deleted schedules are not carried in the index the job scans.
reportScheduleSchema.index(
  { nextRunAt: 1 },
  { partialFilterExpression: { active: true, deletedAt: null } },
);

export const ReportScheduleModel: Model<ReportScheduleDoc> =
  (mongoose.models.ReportSchedule as Model<ReportScheduleDoc>) ??
  mongoose.model<ReportScheduleDoc>('ReportSchedule', reportScheduleSchema, 'report_schedules');
