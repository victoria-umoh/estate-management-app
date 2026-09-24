import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * An uploaded file.
 *
 * Two things are deliberate about this shape.
 *
 * The first is that the row is metadata ONLY. The bytes live in the storage
 * adapter under `storageKey`, which this service generates — a client never
 * supplies a path, because a client-supplied path is a traversal waiting to
 * happen. `filename` is kept because a resident needs to recognise their own
 * NIN slip in a list, but it is display text, never a path component and never
 * a `Content-Type`.
 *
 * The second is that a document is always attached to a SUBJECT. There is no
 * such thing here as a free-floating estate file, because "may this caller read
 * this file?" is not answerable from the file alone: it is answerable from the
 * incident, vehicle, exit pass or resident record it belongs to. Holding
 * `document.view` says you may read documents at all; the subject says which
 * ones.
 */
export const DOCUMENT_SUBJECT_TYPES = [
  'incident',
  'service-request',
  'change-request',
  'vehicle',
  'exit-pass',
  'resident',
] as const;

export type DocumentSubjectType = (typeof DOCUMENT_SUBJECT_TYPES)[number];

export interface DocumentDoc extends TenantDocument {
  /** Storage key. Generated here; never derived from client input. */
  storageKey: string;

  /**
   * The name the uploader's file had.
   *
   * Display text. It is shown in a list and echoed in the download filename
   * after being re-sanitised at that point — it never decides where the bytes
   * are written or what type they are served as.
   */
  filename: string;

  /** The verified type: what the magic bytes said, not what the client claimed. */
  contentType: string;
  size: number;
  /** SHA-256 of the stored bytes, for integrity and duplicate detection. */
  checksum: string;

  subjectType: DocumentSubjectType;
  subjectId: Types.ObjectId;

  /** Optional free-text label — "insurance certificate", "NIN slip". */
  category?: string | null;

  uploadedByUserId: Types.ObjectId;
  uploadedByMembershipId?: Types.ObjectId | null;

  /**
   * Whether the image was re-encoded to drop metadata.
   *
   * Recorded because a resident photo that went through here carries no GPS,
   * and one uploaded before this existed might. That is worth being able to
   * tell apart later.
   */
  metadataStripped: boolean;

  downloadCount: number;
  lastDownloadedAt?: Date | null;

  /**
   * When the bytes were removed from storage.
   *
   * Deleting a document soft-deletes this row — the trail of who uploaded what
   * and who removed it survives — but the object itself is purged, because
   * storage that is never reclaimed is a quota that only ever goes one way.
   */
  purgedAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const documentSchema = new Schema<DocumentDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },

    storageKey: { type: String, required: true, maxlength: 512 },
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    contentType: { type: String, required: true, maxlength: 128 },
    size: { type: Number, required: true, min: 1 },
    checksum: { type: String, required: true, maxlength: 64 },

    subjectType: { type: String, required: true, enum: [...DOCUMENT_SUBJECT_TYPES] },
    subjectId: { type: Schema.Types.ObjectId, required: true },

    category: { type: String, trim: true, maxlength: 60, default: null },

    uploadedByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    uploadedByMembershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },

    metadataStripped: { type: Boolean, default: false },

    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },

    purgedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The list every subject screen runs. */
documentSchema.index({ estateId: 1, subjectType: 1, subjectId: 1, createdAt: -1 });
/** The quota sum, and the estate-wide admin list. */
documentSchema.index({ estateId: 1, deletedAt: 1, createdAt: -1 });
/** A key belongs to exactly one row, so a purge can never orphan another. */
documentSchema.index({ storageKey: 1 }, { unique: true });

export const DocumentModel: Model<DocumentDoc> =
  (mongoose.models.Document as Model<DocumentDoc>) ??
  mongoose.model<DocumentDoc>('Document', documentSchema);
