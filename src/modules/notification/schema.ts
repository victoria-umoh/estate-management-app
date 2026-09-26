import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * In-app notifications and per-resident channel preferences.
 *
 * The in-app record is the DURABLE one. Email and SMS are best-effort copies
 * dispatched through the queue; if both bounce, the resident still has the
 * message the next time they open the app. That ordering is deliberate — it is
 * why the record is written before anything is enqueued.
 */

/**
 * What a notification is about.
 *
 * Categories exist so residents can mute the noisy ones without muting the ones
 * that matter. `emergency` and `security` are listed here for display and
 * grouping only: see MANDATORY_CATEGORIES below.
 */
export type NotificationCategory =
  'emergency' | 'security' | 'visitor' | 'billing' | 'announcement' | 'maintenance' | 'account';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'emergency',
  'security',
  'visitor',
  'billing',
  'announcement',
  'maintenance',
  'account',
] as const;

/**
 * Categories a resident cannot switch off.
 *
 * Someone who muted "alerts" six months ago must still be told that their gate
 * has reported an emergency. A preference is a convenience; a life-safety
 * message is not. Enforced in the service — see `resolveChannels` — rather than
 * by hiding the toggle in the UI, because a UI-only rule is a rule that any API
 * client can ignore.
 */
export const MANDATORY_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  'emergency',
  'security',
]);

export type NotificationChannel = 'in-app' | 'email' | 'sms';

export type NotificationPriority = 'normal' | 'high' | 'critical';

export interface NotificationDoc extends TenantDocument {
  recipientMembershipId: Types.ObjectId;

  templateId: string;
  category: NotificationCategory;
  priority: NotificationPriority;

  title: string;
  /** Rendered at send time and stored, so a later template edit cannot restate history. */
  body: string;

  /** Where the notification points in the app, e.g. `/portal/invoices/123`. */
  actionUrl?: string | null;

  /** What this is about, for grouping and for de-duplication by the caller. */
  resourceType?: string | null;
  resourceId?: string | null;

  /** Channels an outbound job was actually enqueued for. */
  dispatchedChannels: NotificationChannel[];

  readAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    recipientMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },

    templateId: { type: String, required: true, maxlength: 60 },
    category: {
      type: String,
      required: true,
      enum: NOTIFICATION_CATEGORIES as unknown as string[],
    },
    priority: { type: String, enum: ['normal', 'high', 'critical'], default: 'normal' },

    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 4000 },

    actionUrl: { type: String, maxlength: 500, default: null },

    resourceType: { type: String, maxlength: 60, default: null },
    resourceId: { type: String, maxlength: 60, default: null },

    dispatchedChannels: { type: [String], default: [] },

    readAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The list every resident loads on every visit: their own, newest first.
notificationSchema.index({ estateId: 1, recipientMembershipId: 1, createdAt: -1 });
// The unread badge. Partial, because read notifications vastly outnumber unread
// ones and there is no reason to index them for this query.
// `createdAt` is part of the key because the unread list is also sorted by it;
// without it the planner sorts the matches in memory.
notificationSchema.index(
  { estateId: 1, recipientMembershipId: 1, readAt: 1, createdAt: -1 },
  { partialFilterExpression: { readAt: null } },
);

export const NotificationModel: Model<NotificationDoc> =
  (mongoose.models.Notification as Model<NotificationDoc>) ??
  mongoose.model<NotificationDoc>('Notification', notificationSchema, 'notifications');

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface ChannelPreference {
  inApp: boolean;
  email: boolean;
  sms: boolean;
}

export interface NotificationPreferenceDoc extends TenantDocument {
  membershipId: Types.ObjectId;

  /**
   * Category → channels. Stored as a plain subdocument rather than a Map so the
   * shape is explicit in the schema and a typo in a category name is a
   * validation failure rather than a silently-ignored key.
   */
  categories: Record<NotificationCategory, ChannelPreference>;

  /**
   * Quiet hours in the estate's local time, as `HH:mm`. Suppresses SMS only,
   * and never for a mandatory category.
   */
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

/**
 * The defaults a resident gets before they touch anything.
 *
 * In-app is on everywhere: it costs nothing and is the record of last resort.
 * SMS is on only where it earns the money it costs — safety and money.
 */
export const DEFAULT_CHANNEL_PREFERENCES: Record<NotificationCategory, ChannelPreference> = {
  emergency: { inApp: true, email: true, sms: true },
  security: { inApp: true, email: true, sms: true },
  visitor: { inApp: true, email: false, sms: false },
  billing: { inApp: true, email: true, sms: true },
  announcement: { inApp: true, email: true, sms: false },
  maintenance: { inApp: true, email: true, sms: false },
  account: { inApp: true, email: true, sms: false },
};

const channelPreferenceSchema = new Schema<ChannelPreference>(
  {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
  },
  { _id: false },
);

const categoryDefaults = (category: NotificationCategory) => ({
  type: channelPreferenceSchema,
  default: () => ({ ...DEFAULT_CHANNEL_PREFERENCES[category] }),
});

const notificationPreferenceSchema = new Schema<NotificationPreferenceDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    membershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },

    categories: {
      type: new Schema(
        {
          emergency: categoryDefaults('emergency'),
          security: categoryDefaults('security'),
          visitor: categoryDefaults('visitor'),
          billing: categoryDefaults('billing'),
          announcement: categoryDefaults('announcement'),
          maintenance: categoryDefaults('maintenance'),
          account: categoryDefaults('account'),
        },
        { _id: false },
      ),
      default: () => ({}),
    },

    quietHoursStart: { type: String, default: null },
    quietHoursEnd: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One preference document per membership. Without the constraint, a race
// between two concurrent PATCHes leaves two documents and the resident's
// setting appears to revert at random depending on which one is read.
notificationPreferenceSchema.index(
  { estateId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const NotificationPreferenceModel: Model<NotificationPreferenceDoc> =
  (mongoose.models.NotificationPreference as Model<NotificationPreferenceDoc>) ??
  mongoose.model<NotificationPreferenceDoc>(
    'NotificationPreference',
    notificationPreferenceSchema,
    'notification_preferences',
  );
