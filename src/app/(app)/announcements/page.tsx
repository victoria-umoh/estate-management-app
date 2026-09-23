'use client';

import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Pin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api, ApiRequestError, type PageMeta } from '@/lib/api/client';

/**
 * What the estate has told residents.
 *
 * The server already hides drafts and expired notices from anyone without
 * authoring rights — but an administrator hitting this URL gets the unfiltered
 * list back, and would then be reading their own drafts on the page they use to
 * check what residents can see. So the published-and-unexpired filter is
 * applied here as well: this screen is the resident's view by definition, and
 * the admin list lives at /admin/announcements.
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

const PAGE_SIZE = 25;

export default function AnnouncementsPage() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.getPage<Announcement>(
        `/announcements?page=${page}&limit=${PAGE_SIZE}`,
      );
      setItems(result.items.filter(isVisibleToResidents));
      setMeta(result.meta);
      setFailed(false);
      setDenied(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (denied) return <PermissionDeniedState action="read estate announcements" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Announcements</h1>

      {items === null ? (
        <Card>
          <CardContent className="pt-6">
            <SkeletonTable rows={4} columns={2} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Megaphone aria-hidden />}
          title="Nothing announced"
          description="Notices from estate management will appear here."
        />
      ) : (
        <div className="space-y-3">
          {items.map((announcement) => (
            <Card key={announcement.id}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{announcement.title}</CardTitle>
                  {announcement.pinned && (
                    <Badge tone="primary" size="sm">
                      <Pin className="size-3" aria-hidden />
                      pinned
                    </Badge>
                  )}
                </div>
                {/*
                  No author is shown: the API does not return one. Naming a
                  plausible sender would be worse than naming none, since a
                  notice about money or access is acted on partly because of who
                  signed it.
                */}
                <p className="text-muted-foreground text-xs">
                  Published {formatDate(announcement.publishedAt ?? announcement.createdAt)}
                  {announcement.expiresAt && ` · until ${formatDate(announcement.expiresAt)}`}
                </p>
              </CardHeader>
              <CardContent>
                {/* Plain text by contract — the schema says so, so there is no markup to escape. */}
                <p className="text-sm whitespace-pre-wrap">{announcement.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {meta && meta.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs tabular-nums">
            Page {meta.page} of {meta.totalPages}
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
    </div>
  );
}

function isVisibleToResidents(announcement: Announcement): boolean {
  if (announcement.status !== 'published') return false;
  return !announcement.expiresAt || new Date(announcement.expiresAt).getTime() > Date.now();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
