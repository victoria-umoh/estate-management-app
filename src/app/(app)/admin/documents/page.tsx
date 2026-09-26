'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api, type PageMeta } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The document register.
 *
 * This screen shows what is stored and lets it be removed. It deliberately does
 * NOT preview anything inline: every file here was uploaded by somebody, and a
 * preview is how a stored file gets rendered by this origin. Downloading is one
 * explicit click that goes through the audited download route, and the browser
 * saves the file rather than opening it.
 *
 * Deleting is confirmed rather than instant, because the bytes are purged — the
 * row survives for the audit trail, the file does not.
 */
const SUBJECT_TYPES = [
  'incident',
  'service-request',
  'change-request',
  'vehicle',
  'exit-pass',
  'resident',
] as const;

type SubjectType = (typeof SUBJECT_TYPES)[number];

interface DocumentRow {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
  subjectType: SubjectType;
  subjectId: string;
  category: string | null;
  metadataStripped: boolean;
  downloadCount: number;
  createdAt: string;
}

const SUBJECT_LABEL: Record<SubjectType, string> = {
  incident: 'Incident',
  'service-request': 'Service request',
  'change-request': 'Change request',
  vehicle: 'Vehicle',
  'exit-pass': 'Exit pass',
  resident: 'Resident',
};

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [failed, setFailed] = useState(false);
  const [subjectType, setSubjectType] = useState<SubjectType | 'all'>('all');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const filter = subjectType === 'all' ? '' : `&subjectType=${subjectType}`;
      const page = await api.getPage<DocumentRow>(`/documents?limit=50${filter}`);
      setDocuments(page.items);
      setMeta(page.meta);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [subjectType]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (document: DocumentRow) => {
    setProblem(null);
    try {
      await api.delete(`/documents/${document.id}`);
      await load();
    } catch (error) {
      setProblem(
        error instanceof ApiRequestError ? error.message : 'That document could not be removed.',
      );
    }
  };

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
          <p className="text-muted-foreground text-sm">
            {meta ? `${meta.total} stored` : 'Uploaded evidence, papers and scans.'}
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap gap-1.5 p-4 pt-4">
          <FilterChip
            label="All"
            active={subjectType === 'all'}
            onClick={() => setSubjectType('all')}
          />
          {SUBJECT_TYPES.map((value) => (
            <FilterChip
              key={value}
              label={SUBJECT_LABEL[value]}
              active={subjectType === value}
              onClick={() => setSubjectType(value)}
            />
          ))}
        </CardContent>
      </Card>

      {problem && (
        <p className="text-danger text-sm" role="alert">
          {problem}
        </p>
      )}

      <Card>
        <CardContent className="p-2 pt-2 sm:p-4 sm:pt-4">
          {documents === null ? (
            <SkeletonTable rows={6} columns={4} />
          ) : documents.length === 0 ? (
            <EmptyState
              icon={<FileText aria-hidden />}
              variant={subjectType === 'all' ? 'empty' : 'no-results'}
              title={subjectType === 'all' ? 'No documents yet' : 'Nothing of that kind'}
              description={
                subjectType === 'all'
                  ? 'Files attached to incidents, vehicles, exit passes and resident records appear here.'
                  : 'Try a different attachment type.'
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {documents.map((document) => (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5"
                >
                  <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />

                  <span className="min-w-0 flex-1 truncate font-medium" title={document.filename}>
                    {document.filename}
                  </span>

                  <Badge tone="neutral">{SUBJECT_LABEL[document.subjectType]}</Badge>

                  <span className="text-muted-foreground text-sm tabular-nums">
                    {formatSize(document.size)}
                  </span>

                  {document.metadataStripped && (
                    <span
                      className="text-muted-foreground flex items-center gap-1 text-xs"
                      title="Location and camera metadata were removed when this image was uploaded."
                    >
                      <ShieldCheck className="size-3.5" aria-hidden />
                      EXIF removed
                    </span>
                  )}

                  <span className="text-muted-foreground text-xs tabular-nums">
                    {document.downloadCount} download{document.downloadCount === 1 ? '' : 's'}
                  </span>

                  <div className="flex items-center gap-2">
                    {/*
                      A plain link, not a fetch-and-blob: the response already
                      carries Content-Disposition: attachment, so the browser
                      saves it and nothing is ever rendered in this origin.
                    */}
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/v1/documents/${document.id}/download`} download>
                        Download
                      </a>
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${document.filename}`}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      }
                      title="Delete this document?"
                      description={`"${document.filename}" will be removed from storage. The record of who uploaded it and who deleted it is kept; the file itself cannot be recovered.`}
                      confirmLabel="Delete"
                      tone="danger"
                      onConfirm={() => remove(document)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-sm capitalize transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}
