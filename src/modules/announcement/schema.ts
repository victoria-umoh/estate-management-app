import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';
import type { ResidentCategory } from '@/modules/membership/schema';

/**
 * Estate-wide posts.
 *
 * Announcements are CONTENT, written by estate administrators — which is
 * exactly why they are not notification templates. A template is a program that
 * decides what the platform says to everyone; an announcement is one message
 * that an administrator chose to send. Keeping them apart means an estate can
 * say what it likes without being able to rewrite a password-reset email.
 */

export type AnnouncementStatus = 'draft' | 'published' | 'archived';

/**
 * Who sees it.
 *
 * `all` means every active member. `categories` targets resident categories —
 * a levy notice for homeowners, a gate-procedure change for domestic staff.
 */
export interface AnnouncementAudience {
  type: 'all' | 'categories';
  categories: ResidentCategory[];
}

export interface AnnouncementDoc extends TenantDocument {
  title: string;
  /** Plain text. Rendered as text by every surface, so there is no markup to escape. */
  body: string;
  /** One-line version used in the notification and the list. */
  summary: string;

  status: AnnouncementStatus;
  audience: AnnouncementAudience;

  /** Holds it at the top of the list until unpinned or expired. */
  pinned: boolean;
  /** After this, it stops appearing to residents. Null means it never expires. */
  expiresAt?: Date | null;

  authorMembershipId: Types.ObjectId;

  publishedAt?: Date | null;
  publishedByMembershipId?: Types.ObjectId | null;
  /** How many residents the publish actually reached, for the author's record. */
  notifiedCount: number;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const audienceSchema = new Schema<AnnouncementAudience>(
  {
    type: { type: String, required: true, enum: ['all', 'categories'], default: 'all' },
    categories: { type: [String], default: [] },
  },
  { _id: false },
);

const announcementSchema = new Schema<AnnouncementDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, maxlength: 20_000 },
    summary: { type: String, required: true, maxlength: 280 },

    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
    audience: { type: audienceSchema, default: () => ({ type: 'all', categories: [] }) },

    pinned: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null },

    authorMembershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },

    publishedAt: { type: Date, default: null },
    publishedByMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    notifiedCount: { type: Number, default: 0 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The resident feed: published, unexpired, pinned first, newest next.
announcementSchema.index({ estateId: 1, status: 1, pinned: -1, publishedAt: -1 });
// The administrator's own drafts.
announcementSchema.index({ estateId: 1, authorMembershipId: 1, createdAt: -1 });

export const AnnouncementModel: Model<AnnouncementDoc> =
  (mongoose.models.Announcement as Model<AnnouncementDoc>) ??
  mongoose.model<AnnouncementDoc>('Announcement', announcementSchema, 'announcements');
