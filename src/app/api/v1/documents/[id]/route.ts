import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { documentService } from '@/modules/document';

const Params = z.object({ id: z.string() });

/**
 * Document metadata.
 *
 * The bytes are not here — this answers "what is attached", and the separate
 * download route answers "give me a copy". A caller who may see that a file
 * exists is not thereby allowed to take it away.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.DOCUMENT_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const document = await documentService.detail(ctx, params.id);

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
  },
});

export const DELETE = defineRoute({
  permissions: [PERMISSIONS.DOCUMENT_DELETE],
  params: Params,
  requiresActiveSubscription: true,
  idempotent: true,
  handler: async (ctx, { params }) => {
    await documentService.remove(ctx, params.id);
    return { id: params.id, deleted: true };
  },
});
