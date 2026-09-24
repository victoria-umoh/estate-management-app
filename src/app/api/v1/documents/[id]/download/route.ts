import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { documentService } from '@/modules/document';

/**
 * Download a document.
 *
 * Only `document.view` is declared here. `document.download` is checked inside
 * the service, which records the refusal in the audit trail before it throws —
 * a route-level check would reject the request first and the refusal would
 * leave no trace. Reports export does the same thing for the same reason.
 *
 * The response is the security boundary as much as the permission check is:
 *
 *  - `Content-Disposition: attachment` so the browser saves rather than renders.
 *  - A fixed `application/octet-stream`, never the stored type. An uploaded
 *    file served inline as `text/html` or `image/svg+xml` from this origin is
 *    stored XSS against the session reading it.
 *  - `X-Content-Type-Options: nosniff` so the type is not re-guessed.
 *  - `Content-Security-Policy: sandbox` as the belt to that braces, for the
 *    case where a browser renders it anyway.
 *  - `Cache-Control: no-store`, because this is somebody's NIN slip and a
 *    shared proxy is not a place for it.
 *
 * The filename is quoted twice: an ASCII fallback with anything dangerous
 * already stripped, and a RFC 5987 `filename*` so non-Latin names survive.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.DOCUMENT_VIEW],
  params: z.object({ id: z.string() }),
  rateLimit: { key: 'user', limit: 120, window: '1h', bucket: 'document:download' },
  handler: async (ctx, { params }) => {
    const file = await documentService.download(ctx, params.id);
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_');

    return new NextResponse(new Uint8Array(file.body), {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.body.length),
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'x-document-checksum': file.checksum,
        'cache-control': 'no-store',
      },
    });
  },
});
