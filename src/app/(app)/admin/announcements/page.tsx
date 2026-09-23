'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, Lock, Megaphone, Pencil, Pin, Plus, Send } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api, ApiRequestError, type PageMeta } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Writing and sending estate announcements.
 *
 * Two rules from the service shape this screen, and both are stated in the UI
 * rather than left to be discovered by a rejected request:
 *
 * Publishing fans out a notification to every targeted resident and cannot be
 * undone, so it goes through a confirmation that says how many people it
 * reaches, not a button next to "save".
 *
 * A published announcement's words are frozen. Residents have already been told
 * them, and quietly rewriting a "the gate closes at 10pm" notice after someone
 * acted on it is a dispute nobody can settle. Pinning and expiry stay editable
 * because neither changes what was said — so the editor shows the text as read
 * only once published, instead of offering a field the server will reject.
 */
interface Announcement {
  id: string;
  title: string;
  summary: string;
  body: string;
  status: 'draft' | 'published' | 'archived';
  audience: { type: 'all' | 'categories'; categories: string[] };
  pinned: boolean;
  expiresAt: string | null;
  publishedAt: string | null;
  notifiedCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The audience values the API accepts, as listed in
 * `src/app/api/v1/announcements/route.ts`. Anything outside this set is a 422,
 * so the selector is built from it rather than from free text.
 */
const RESIDENT_CATEGORIES = [
  'homeowner',
  'landlord',
  'tenant',
  'dependant',
  'family-member',
  'domestic-staff',
  'estate-staff',
  'security-personnel',
  'contractor',
  'other',
] as const;

const STATUSES = ['draft', 'published', 'archived'] as const;

const STATUS_TONE: Record<Announcement['status'], 'neutral' | 'success' | 'warning'> = {
  draft: 'warning',
  published: 'success',
  archived: 'neutral',
};

const PAGE_SIZE = 25;

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'' | Announcement['status']>('');
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.getPage<Announcement>(
        `/announcements?page=${page}&limit=${PAGE_SIZE}${status ? `&status=${status}` : ''}`,
      );
      setItems(result.items);
      setMeta(result.meta);
      setFailed(false);
      setDenied(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setProblem(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setProblem(caught instanceof ApiRequestError ? caught.message : 'That did not go through.');
    }
  }

  if (denied) return <PermissionDeniedState action="manage announcements" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Announcements</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          New draft
        </Button>
      </div>

      {problem && <Alert tone="danger">{problem}</Alert>}

      <div className="flex flex-wrap gap-2">
        <FilterButton active={status === ''} onClick={() => changeStatus('')}>
          All
        </FilterButton>
        {STATUSES.map((value) => (
          <FilterButton key={value} active={status === value} onClick={() => changeStatus(value)}>
            {value}
          </FilterButton>
        ))}
      </div>

      {items === null ? (
        <Card>
          <CardContent className="pt-6">
            <SkeletonTable rows={5} columns={3} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Megaphone aria-hidden />}
          variant={status ? 'no-results' : 'empty'}
          title={status ? `No ${status} announcements` : 'Nothing written yet'}
          description="Drafts are private until you publish them."
          action={
            status ? undefined : <Button onClick={() => setCreating(true)}>Write the first</Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((announcement) => (
            <AnnouncementCard
              key={announcement.id}
              announcement={announcement}
              onEdit={() => setEditing(announcement)}
              onPublish={() =>
                run(() =>
                  api.post(`/announcements/${announcement.id}/publish`, undefined, {
                    // Publishing is the one action here that puts a message in
                    // front of the whole estate; a retried request must not
                    // send it twice.
                    idempotencyKey: `publish-${announcement.id}`,
                  }),
                )
              }
              onArchive={() => run(() => api.delete(`/announcements/${announcement.id}`))}
            />
          ))}
        </div>
      )}

      {meta && meta.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs tabular-nums">
            Page {meta.page} of {meta.totalPages} · {meta.total} in total
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={meta.page <= 1}
              onClick={() => setPage(meta.page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!meta.hasNextPage}
              onClick={() => setPage(meta.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <EditorDialog
        open={creating || editing !== null}
        announcement={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          void load();
        }}
      />
    </div>
  );

  function changeStatus(next: '' | Announcement['status']) {
    setStatus(next);
    setPage(1);
  }
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button size="sm" variant={active ? 'primary' : 'outline'} onClick={onClick}>
      <span className="capitalize">{children}</span>
    </Button>
  );
}

function AnnouncementCard({
  announcement,
  onEdit,
  onPublish,
  onArchive,
}: {
  announcement: Announcement;
  onEdit: () => void;
  onPublish: () => void;
  onArchive: () => void;
}) {
  const audience =
    announcement.audience.type === 'all'
      ? 'everyone'
      : announcement.audience.categories.join(', ') || 'nobody';

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{announcement.title}</CardTitle>
          <Badge tone={STATUS_TONE[announcement.status]} size="sm" dot>
            {announcement.status}
          </Badge>
          {announcement.pinned && (
            <Badge tone="primary" size="sm">
              <Pin className="size-3" aria-hidden />
              pinned
            </Badge>
          )}
        </div>

        <p className="text-muted-foreground text-xs text-pretty">
          To {audience}
          {announcement.publishedAt && ` · published ${formatDate(announcement.publishedAt)}`}
          {announcement.status === 'published' && (
            <span className="tabular-nums"> · {announcement.notifiedCount} notified</span>
          )}
          {announcement.expiresAt && ` · expires ${formatDate(announcement.expiresAt)}`}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm text-pretty">{announcement.summary}</p>

        <div className="flex flex-wrap gap-2">
          {announcement.status !== 'archived' && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil aria-hidden />
              {announcement.status === 'published' ? 'Pin and expiry' : 'Edit'}
            </Button>
          )}

          {announcement.status === 'draft' && (
            <ConfirmDialog
              trigger={
                <Button size="sm">
                  <Send aria-hidden />
                  Publish
                </Button>
              }
              title={`Publish "${announcement.title}"?`}
              description={`This sends a notification to ${audience} on whatever channels they have enabled, and cannot be undone. The text is frozen once published — only pinning and expiry stay editable.`}
              confirmLabel="Publish and notify"
              onConfirm={onPublish}
            />
          )}

          {announcement.status !== 'archived' && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="danger">
                  <Archive aria-hidden />
                  Archive
                </Button>
              }
              title={`Archive "${announcement.title}"?`}
              description="It stops appearing to residents. Notifications already sent are not recalled, and the announcement is kept so the audit trail still resolves."
              confirmLabel="Archive"
              tone="danger"
              onConfirm={onArchive}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EditorDialog({
  open,
  announcement,
  onClose,
  onSaved,
}: {
  open: boolean;
  announcement: Announcement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const frozen = announcement?.status === 'published';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [summary, setSummary] = useState('');
  const [audienceType, setAudienceType] = useState<'all' | 'categories'>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setTitle(announcement?.title ?? '');
    setBody(announcement?.body ?? '');
    setSummary(announcement?.summary ?? '');
    setAudienceType(announcement?.audience.type ?? 'all');
    setCategories(announcement?.audience.categories ?? []);
    setPinned(announcement?.pinned ?? false);
    setExpiresAt(announcement?.expiresAt ? announcement.expiresAt.slice(0, 10) : '');
    setError(null);
  }, [open, announcement]);

  async function submit() {
    setSubmitting(true);
    setError(null);

    try {
      // Expiry is a date input, so an empty box means "never" — null, not
      // absent, because absent would leave an existing expiry in place.
      const scheduling = {
        pinned,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      };

      if (announcement) {
        // A published announcement's words are frozen server-side; sending them
        // unchanged would still be a 409, so only the editable half is sent.
        await api.patch(
          `/announcements/${announcement.id}`,
          frozen
            ? scheduling
            : {
                title,
                body,
                ...(summary ? { summary } : {}),
                audience: {
                  type: audienceType,
                  ...(audienceType === 'categories' ? { categories } : {}),
                },
                ...scheduling,
              },
        );
      } else {
        await api.post('/announcements', {
          title,
          body,
          ...(summary ? { summary } : {}),
          audience: {
            type: audienceType,
            ...(audienceType === 'categories' ? { categories } : {}),
          },
          ...scheduling,
        });
      }

      onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not save this announcement.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const incomplete = !frozen && (title.trim() === '' || body.trim() === '');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {announcement ? (frozen ? 'Pinning and expiry' : 'Edit draft') : 'New announcement'}
          </DialogTitle>
          <DialogDescription>
            {frozen
              ? 'This has been sent. What it says is fixed; when it shows and where it sits are not.'
              : 'Saved as a draft. Publishing is a separate, confirmed step.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}

          {frozen ? (
            <div className="space-y-2">
              <Alert tone="info" title="Already sent">
                Residents have been notified of this wording. To correct it, archive this and
                publish a replacement, so the record shows both.
              </Alert>
              <div className="border-input bg-muted/40 rounded-md border p-3">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-2 text-sm whitespace-pre-wrap">{body}</p>
              </div>
            </div>
          ) : (
            <>
              <Input
                label="Title"
                required
                maxLength={160}
                placeholder="Gate closing time changes from Monday"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />

              <label className="block space-y-1.5">
                <span className="text-foreground block text-sm font-medium">
                  Announcement
                  <span className="text-danger ml-0.5" aria-label="required">
                    *
                  </span>
                </span>
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={6}
                  maxLength={20_000}
                  placeholder="Plain text. Say what changed, when it takes effect, and who to ask."
                  className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                />
              </label>

              <Input
                label="Summary"
                maxLength={280}
                hint="The one line residents see in their notification. Left blank, the first sentence is used."
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />

              <label className="block space-y-1.5">
                <span className="text-foreground block text-sm font-medium">Audience</span>
                <select
                  value={audienceType}
                  onChange={(event) => setAudienceType(event.target.value as 'all' | 'categories')}
                  className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <option value="all">Everyone on the estate</option>
                  <option value="categories">Selected resident categories</option>
                </select>
              </label>

              {audienceType === 'categories' && (
                <div className="flex flex-wrap gap-1.5">
                  {RESIDENT_CATEGORIES.map((category) => {
                    const chosen = categories.includes(category);
                    return (
                      <button
                        key={category}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() =>
                          setCategories((current) =>
                            chosen
                              ? current.filter((value) => value !== category)
                              : [...current, category],
                          )
                        }
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs',
                          chosen
                            ? 'border-primary bg-primary-muted text-primary'
                            : 'border-input text-muted-foreground',
                        )}
                      >
                        {category}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          <label className="flex cursor-pointer items-start gap-3 py-1">
            <input
              type="checkbox"
              className="accent-primary mt-0.5 size-4 shrink-0"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Pin to the top</span>
              <span className="text-muted-foreground block text-xs text-pretty">
                Holds it above everything else in the resident feed until unpinned or expired.
              </span>
            </span>
          </label>

          <Input
            label="Stops showing on"
            type="date"
            hint="Leave blank to keep it visible indefinitely."
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />

          {!announcement && (
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs text-pretty">
              <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
              Nobody is notified until you publish, and the text cannot be changed after that.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={submitting} disabled={incomplete}>
            {announcement ? 'Save' : 'Save draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
