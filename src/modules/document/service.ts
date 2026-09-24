import { Types } from 'mongoose';
import { BaseRepository, type PaginatedResult } from '@/core/db';
import { config } from '@/core/config';
import { NotFoundError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { getStorage, validateUpload } from '@/integrations/storage';
import { auditService } from '@/modules/audit';
import { meService } from '@/modules/me';
import { stripImageMetadata } from './metadata';
import { DocumentModel, type DocumentDoc, type DocumentSubjectType } from './schema';
import { accessorFor } from './subjects';

const log = createLogger('document');

class DocumentRepository extends BaseRepository<DocumentDoc> {
  constructor() {
    super(DocumentModel);
  }
}

export const documentRepository = new DocumentRepository();

/**
 * Total bytes one estate may hold.
 *
 * Per-file size is capped by the storage validator; this is the other half,
 * because a per-file cap alone is a rate limit on a single upload and not a
 * bound on the bill. Two gigabytes is roughly ten thousand phone photographs —
 * generous for an estate, and small enough that a script filling the disk trips
 * it within the hour rather than over a weekend.
 *
 * Injectable on the service rather than read from the environment at the call
 * site, so a test can prove the refusal without writing two gigabytes.
 */
export const DEFAULT_ESTATE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface UploadDocumentInput {
  subjectType: DocumentSubjectType;
  subjectId: string;
  filename: string;
  /** What the client claimed. Trusted only far enough to be checked. */
  contentType: string;
  body: Buffer;
  category?: string;
}

export interface DocumentDownload {
  filename: string;
  contentType: string;
  body: Buffer;
  checksum: string;
}

/**
 * Documents.
 *
 * The threat model here is not subtle, so neither is the code.
 *
 * An upload endpoint is the shortest path an outsider has to putting bytes of
 * their choosing on your infrastructure, so: the declared `Content-Type` is
 * treated as a claim and checked against the magic bytes, the stored key is
 * generated here and never taken from the client, per-file and per-estate size
 * limits are both enforced and the refusal names which one was hit, and image
 * metadata is dropped on the way in.
 *
 * A download endpoint is the shortest path from "they stored a file" to "your
 * own domain served their script". So nothing is ever served inline from a
 * user-supplied type: a download is `Content-Disposition: attachment` with a
 * fixed `application/octet-stream`, from a route that has already answered the
 * permission question. There is no public URL and no unauthenticated key path.
 *
 * `document.download` is checked separately from `document.view`, for the same
 * reason `report.export` is separate from `report.view` — seeing that a file
 * exists and taking a copy of it out of the building are different acts. Both
 * the refusal and the success are audited here in the SERVICE, not at the
 * route, because a route-level check rejects the request before anything is
 * written and a pattern of refused downloads is precisely the signal worth
 * keeping.
 */
export class DocumentService {
  constructor(private readonly quotaBytes: number = DEFAULT_ESTATE_QUOTA_BYTES) {}

  async upload(context: RequestContext, input: UploadDocumentInput): Promise<DocumentDoc> {
    assertCan(context, PERMISSIONS.DOCUMENT_UPLOAD);

    const accessor = accessorFor(input.subjectType);
    // Attaching to a record you may not read would let a stranger append
    // evidence to somebody else's incident — and then read it back, since the
    // document is now legitimately attached.
    await accessor.assertReadable(context, input.subjectId);

    // Validated BEFORE the quota query and before storage is touched, so a
    // malformed or oversized file costs one round trip and nothing else.
    validateUpload({ contentType: input.contentType, body: input.body });

    const { body, stripped } = stripImageMetadata(input.body, input.contentType);

    await this.assertWithinQuota(context, body.length);

    const storage = await getStorage();
    const stored = await storage.upload({
      prefix: `${context.estateId}/${input.subjectType}/${input.subjectId}`,
      filename: input.filename,
      contentType: input.contentType,
      body,
    });

    const membership = await meService.membership(context).catch(() => null);

    const document = await documentRepository.create(context, {
      storageKey: stored.key,
      filename: safeDisplayName(input.filename),
      contentType: stored.contentType,
      size: stored.size,
      checksum: stored.checksum,
      subjectType: input.subjectType,
      subjectId: new Types.ObjectId(input.subjectId),
      ...(input.category ? { category: input.category.trim().slice(0, 60) } : {}),
      uploadedByUserId: new Types.ObjectId(context.userId),
      ...(membership ? { uploadedByMembershipId: membership._id } : {}),
      metadataStripped: stripped,
    });

    await accessor.attach?.(context, input.subjectId, document._id);

    await auditService.record(context, {
      action: 'document.uploaded',
      resource: 'document',
      resourceId: document._id,
      metadata: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        filename: document.filename,
        contentType: document.contentType,
        size: document.size,
        checksum: document.checksum,
        metadataStripped: stripped,
      },
    });

    return document;
  }

  /** Documents on one subject. */
  async listForSubject(
    context: RequestContext,
    subjectType: DocumentSubjectType,
    subjectId: string,
  ): Promise<DocumentDoc[]> {
    assertCan(context, PERMISSIONS.DOCUMENT_VIEW);
    await accessorFor(subjectType).assertReadable(context, subjectId);

    return documentRepository.findMany(
      context,
      { subjectType, subjectId: new Types.ObjectId(subjectId) },
      { sort: { createdAt: -1 } },
    );
  }

  /**
   * The estate-wide list, for the admin screen.
   *
   * Every other read in this file re-asks the owning module whether the caller
   * may see the subject. This one cannot: it is a list ACROSS subjects, so
   * there is no single subject to ask about, and checking a hundred of them per
   * page would be a hundred queries to render a table.
   *
   * So it is gated instead on `resident.viewAll` — the permission that already
   * means "may read every household's record in this estate". `document.view`
   * alone is held by every resident so their own papers appear on their own
   * screen, and a subject-blind list offered to that permission is precisely
   * the leak the per-subject checks exist to prevent.
   */
  async list(
    context: RequestContext,
    filters: { subjectType?: DocumentSubjectType } = {},
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<DocumentDoc>> {
    assertCan(context, PERMISSIONS.DOCUMENT_VIEW);
    assertCan(context, PERMISSIONS.RESIDENT_VIEW_ALL);

    return documentRepository.paginate(
      context,
      { ...(filters.subjectType ? { subjectType: filters.subjectType } : {}) },
      pagination,
      { sort: { createdAt: -1 } },
    );
  }

  /** Metadata for one document. Does not read the bytes. */
  async detail(context: RequestContext, documentId: string): Promise<DocumentDoc> {
    assertCan(context, PERMISSIONS.DOCUMENT_VIEW);

    const document = await documentRepository.findById(context, documentId);
    if (!document) throw new NotFoundError('Document');

    await accessorFor(document.subjectType).assertReadable(
      context,
      document.subjectId.toHexString(),
    );

    return document;
  }

  /**
   * Take a copy out.
   *
   * Every attempt lands in the audit trail, refusals included. The returned
   * type is deliberately fixed rather than the stored one: the caller writes it
   * to a response with `Content-Disposition: attachment`, so a stored PDF or
   * SVG is never a document the browser will execute against this origin.
   */
  async download(context: RequestContext, documentId: string): Promise<DocumentDownload> {
    assertCan(context, PERMISSIONS.DOCUMENT_VIEW);

    if (!can(context, PERMISSIONS.DOCUMENT_DOWNLOAD)) {
      await auditService.recordFailure(context, {
        action: 'document.download.denied',
        resource: 'document',
        resourceId: documentId,
        reason: `Missing "${PERMISSIONS.DOCUMENT_DOWNLOAD}".`,
      });
    }
    assertCan(context, PERMISSIONS.DOCUMENT_DOWNLOAD);

    const document = await documentRepository.findById(context, documentId);
    if (!document) throw new NotFoundError('Document');

    // The subject check runs before the bytes are fetched, so a refusal never
    // costs a storage read.
    await accessorFor(document.subjectType).assertReadable(
      context,
      document.subjectId.toHexString(),
    );

    const storage = await getStorage();
    const body = await storage.download(document.storageKey);

    await documentRepository.updateById(context, document._id, {
      $inc: { downloadCount: 1 },
      $set: { lastDownloadedAt: new Date() },
    });

    await auditService.record(context, {
      action: 'document.downloaded',
      resource: 'document',
      resourceId: document._id,
      metadata: {
        subjectType: document.subjectType,
        subjectId: document.subjectId.toHexString(),
        filename: document.filename,
        size: document.size,
        checksum: document.checksum,
      },
    });

    return {
      filename: safeDisplayName(document.filename),
      // NOT the stored type. See the class comment: a fixed, inert type is what
      // stops a stored file being rendered by this origin.
      contentType: 'application/octet-stream',
      body,
      checksum: document.checksum,
    };
  }

  /**
   * Remove a document.
   *
   * The row is soft-deleted so the trail of who uploaded what, and who removed
   * it, survives. The bytes are purged, because storage that is never reclaimed
   * turns the per-estate quota into a one-way ratchet — an estate that uploads
   * and deletes the same file a thousand times would otherwise be permanently
   * full.
   */
  async remove(context: RequestContext, documentId: string): Promise<void> {
    assertCan(context, PERMISSIONS.DOCUMENT_DELETE);

    const document = await documentRepository.findById(context, documentId);
    if (!document) throw new NotFoundError('Document');

    const accessor = accessorFor(document.subjectType);
    await accessor.assertReadable(context, document.subjectId.toHexString());

    const storage = await getStorage();
    // A failed purge must not leave a readable document whose row says deleted.
    // Log it for reconciliation and carry on with the soft delete.
    const purged = await storage
      .delete(document.storageKey)
      .then(() => true)
      .catch((error: unknown) => {
        log.error(
          { err: error, documentId, storageKey: document.storageKey },
          'failed to purge stored object',
        );
        return false;
      });

    await documentRepository.updateById(context, document._id, {
      $set: { deletedAt: new Date(), ...(purged ? { purgedAt: new Date() } : {}) },
    });

    await accessor.detach?.(context, document.subjectId.toHexString(), document._id);

    await auditService.record(context, {
      action: 'document.deleted',
      resource: 'document',
      resourceId: document._id,
      metadata: {
        subjectType: document.subjectType,
        subjectId: document.subjectId.toHexString(),
        filename: document.filename,
        size: document.size,
        purged,
      },
    });
  }

  /** Bytes currently held by this estate, and the ceiling. */
  async usage(context: RequestContext): Promise<{ usedBytes: number; quotaBytes: number }> {
    const [summary] = await documentRepository.aggregate<{ used: number }>(context, [
      { $group: { _id: null, used: { $sum: '$size' } } },
    ]);

    return { usedBytes: summary?.used ?? 0, quotaBytes: this.quotaBytes };
  }

  /**
   * Refuse an upload that would take the estate over its ceiling.
   *
   * The message names the limit that was hit and how much room is left. A bare
   * "upload failed" here is what turns a capacity problem into a support
   * ticket, and the numbers are the estate's own — nothing is disclosed.
   */
  private async assertWithinQuota(context: RequestContext, incomingBytes: number): Promise<void> {
    const { usedBytes, quotaBytes } = await this.usage(context);

    if (usedBytes + incomingBytes <= quotaBytes) return;

    const remaining = Math.max(0, quotaBytes - usedBytes);
    throw new UnprocessableError(
      `This estate has used ${megabytes(usedBytes)} of its ${megabytes(quotaBytes)} document storage. ` +
        `This file needs ${megabytes(incomingBytes)} and only ${megabytes(remaining)} is free. ` +
        'Delete documents that are no longer needed, or ask for the estate limit to be raised.',
    );
  }
}

export const documentService = new DocumentService();

// -----------------------------------------------------------------------------

function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * A filename safe to show and to echo in a `Content-Disposition` header.
 *
 * Quotes, newlines and control characters are removed rather than escaped: a
 * newline here is a response-splitting primitive, and a quote ends the header
 * parameter early. Path separators go too — the name is never a path, but
 * nothing is gained by keeping the parts that would make it look like one.
 */
export function safeDisplayName(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = filename.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, ' ').trim();
  // Leading dots and spaces go together and repeatedly: "../.. name" must not
  // come out still looking like a relative path.
  const collapsed = cleaned.replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, 120);
  return collapsed.length > 0 ? collapsed : 'document';
}

/** Surfaced so routes can reject an oversized body before buffering it. */
export function maxUploadBytes(): number {
  return config.storage.maxFileSizeBytes;
}
