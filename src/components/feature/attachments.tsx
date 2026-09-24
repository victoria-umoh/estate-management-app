'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Paperclip, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';

/**
 * The files attached to one record.
 *
 * Built once and shared, because an incident, a service request and an exit
 * pass all ask the same question — what was attached to this, and can I add to
 * it — and three copies of that would drift.
 *
 * Reading and writing are separately permitted, and the panel reflects that.
 * Someone who may see the record but not upload gets the list with no control,
 * rather than a button that fails when pressed. The server is still the
 * authority; this only avoids offering an action that will be refused.
 *
 * Downloads are plain links to the audited route, never inline previews. The
 * route forces `application/octet-stream` with `nosniff` and a `sandbox` CSP
 * precisely so an uploaded file cannot execute in the estate's origin, and
 * rendering it in an <img> or <iframe> here would work around that.
 */
export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  metadataStripped: boolean;
  downloadCount: number;
  createdAt: string;
}

export function Attachments({
  subjectType,
  subjectId,
  canUpload = true,
}: {
  subjectType: 'incident' | 'service-request' | 'exit-pass' | 'vehicle' | 'resident';
  subjectId: string;
  canUpload?: boolean;
}) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/documents?subjectType=${subjectType}&subjectId=${subjectId}`,
        { credentials: 'same-origin' },
      );

      if (!response.ok) {
        // A refusal here is not an error state for the whole screen: the record
        // is readable, the attachments are not, and the panel says only that.
        setItems([]);
        return;
      }

      const body = await response.json();
      setItems(body?.data ?? []);
    } catch {
      setItems([]);
    }
  }, [subjectType, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setProblem(null);

    const form = new FormData();
    form.set('file', file);
    form.set('subjectType', subjectType);
    form.set('subjectId', subjectId);

    try {
      const response = await fetch('/api/v1/documents', {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        // The server distinguishes a wrong type from a mismatched one from an
        // oversized one, and those messages are worth showing verbatim rather
        // than flattening into "upload failed".
        setProblem(body?.error?.message ?? 'That file could not be uploaded.');
        return;
      }

      toast.success(`${file.name} attached`);
      await load();
    } catch {
      setProblem('That file could not be uploaded.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4" aria-hidden />
          Attachments
          {items && items.length > 0 && (
            <Badge tone="neutral" size="sm">
              {items.length}
            </Badge>
          )}
        </CardTitle>

        {canUpload && (
          <>
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              aria-label="Attach a file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <Upload aria-hidden />
              {busy ? 'Uploading…' : 'Attach'}
            </Button>
          </>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {problem && <Alert tone="danger">{problem}</Alert>}

        {items === null ? (
          <SkeletonTable rows={2} columns={2} />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing attached"
            description={
              canUpload
                ? 'Photographs and documents attached to this record appear here.'
                : 'No files have been attached to this record.'
            }
          />
        ) : (
          <ul aria-label="Attachments" className="divide-border divide-y">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.filename}</span>

                {/* Says the photograph's location data was removed. A gate
                    photograph carries GPS coordinates by default, and whether
                    those were stripped is worth stating rather than assuming. */}
                {item.metadataStripped && (
                  <Badge tone="success" size="sm">
                    <ShieldCheck className="size-3" aria-hidden />
                    metadata stripped
                  </Badge>
                )}

                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatSize(item.size)}
                </span>

                <Button variant="ghost" size="sm" asChild>
                  <a href={`/api/v1/documents/${item.id}/download`} download>
                    <Download aria-hidden />
                    <span className="sr-only">Download {item.filename}</span>
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
