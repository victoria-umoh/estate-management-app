import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { ValidationError } from '@/core/errors';
import { PERMISSIONS } from '@/core/rbac';
import {
  DOCUMENT_SUBJECT_TYPES,
  documentService,
  maxUploadBytes,
  type DocumentDoc,
  type DocumentSubjectType,
} from '@/modules/document';

const SubjectType = z.enum(DOCUMENT_SUBJECT_TYPES);

function present(document: DocumentDoc) {
  return {
    id: document._id.toHexString(),
    filename: document.filename,
    contentType: document.contentType,
    size: document.size,
    checksum: document.checksum,
    subjectType: document.subjectType,
    subjectId: document.subjectId.toHexString(),
    category: document.category ?? null,
    metadataStripped: document.metadataStripped,
    uploadedByMembershipId: document.uploadedByMembershipId?.toHexString() ?? null,
    downloadCount: document.downloadCount,
    lastDownloadedAt: document.lastDownloadedAt ?? null,
    createdAt: document.createdAt,
  };
}

/**
 * List documents.
 *
 * With a subject, this is the attachment list for that record and the caller
 * must be allowed to read the record. Without one it is the estate-wide admin
 * list, which the service gates more tightly — `document.view` alone is held by
 * every resident and is deliberately not enough to enumerate the estate.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.DOCUMENT_VIEW],
  query: z.object({
    subjectType: SubjectType.optional(),
    subjectId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    if (query.subjectId) {
      if (!query.subjectType) {
        throw new ValidationError('subjectType is required when subjectId is given.');
      }

      const items = await documentService.listForSubject(ctx, query.subjectType, query.subjectId);
      return items.map(present);
    }

    const result = await documentService.list(
      ctx,
      { ...(query.subjectType ? { subjectType: query.subjectType } : {}) },
      { page: query.page, limit: query.limit },
    );

    return paginated({ ...result, items: result.items.map(present) });
  },
});

/**
 * Upload a file.
 *
 * Multipart, so there is no body schema here — the fields are pulled off the
 * form and validated below. The `Content-Length` check is a cheap pre-filter:
 * it refuses an obviously oversized request before the body is buffered into
 * memory. It is not the size limit. The real one is enforced on the bytes
 * actually received, because a length header is a claim like any other.
 *
 * Nothing about the stored object comes from the client: the key is generated
 * server-side, and the type recorded is the one the magic bytes proved.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.DOCUMENT_UPLOAD],
  requiresActiveSubscription: true,
  rateLimit: { key: 'user', limit: 60, window: '1h', bucket: 'document:upload' },
  handler: async (ctx, { request }) => {
    const limit = maxUploadBytes();
    const declaredLength = Number(request.headers.get('content-length') ?? 0);

    // Multipart framing adds a few hundred bytes; the slack keeps a file that
    // is exactly at the limit from being refused by the pre-filter.
    if (declaredLength > limit + 8 * 1024) {
      throw new ValidationError(
        `Files must be ${Math.floor(limit / 1024 / 1024)}MB or smaller. That request declared ${(declaredLength / 1024 / 1024).toFixed(1)}MB.`,
      );
    }

    const form = await request.formData().catch(() => {
      throw new ValidationError('Expected a multipart/form-data upload.');
    });

    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new ValidationError('No file was included in the upload. Send it as the "file" field.');
    }

    const subjectType = SubjectType.safeParse(form.get('subjectType'));
    if (!subjectType.success) {
      throw new ValidationError(
        `subjectType must be one of: ${DOCUMENT_SUBJECT_TYPES.join(', ')}.`,
      );
    }

    const subjectId = form.get('subjectId');
    if (typeof subjectId !== 'string' || subjectId.trim() === '') {
      throw new ValidationError('subjectId is required.');
    }

    const category = form.get('category');
    const body = Buffer.from(await file.arrayBuffer());

    const document = await documentService.upload(ctx, {
      subjectType: subjectType.data as DocumentSubjectType,
      subjectId: subjectId.trim(),
      filename: file.name || 'upload',
      // The browser's claim. `validateUpload` checks it against the magic bytes
      // and refuses the pair if they disagree.
      contentType: file.type || 'application/octet-stream',
      body,
      ...(typeof category === 'string' && category.trim() !== ''
        ? { category: category.trim() }
        : {}),
    });

    return present(document);
  },
});
