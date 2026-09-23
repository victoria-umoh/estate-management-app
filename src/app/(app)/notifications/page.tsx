'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCheck, Lock } from 'lucide-react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api, ApiRequestError, type PageMeta } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The resident's own notifications, and the preferences that govern them.
 *
 * Preferences sit on this page rather than under settings because the question
 * "why am I getting these?" is asked while looking at the list, not while
 * hunting through a menu.
 *
 * The mandatory rows are the reason this screen exists in this shape. The
 * service silently ignores an attempt to mute emergency or security — a
 * resident who muted alerts six months ago must still be told their gate has
 * reported an emergency — so those rows are rendered locked with the reason
 * stated. A toggle that appears to work and then does nothing is worse than no
 * toggle at all: it teaches someone they are covered when they are not.
 */
interface Notification {
  id: string;
  templateId: string;
  category: string;
  priority: 'normal' | 'high' | 'critical';
  title: string;
  body: string;
  actionUrl: string | null;
  resourceType: string | null;
  resourceId: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

interface ChannelPreference {
  inApp: boolean;
  email: boolean;
  sms: boolean;
}

/**
 * Mirrors `MANDATORY_CATEGORIES` in `src/modules/notification/schema.ts`.
 *
 * Restated rather than imported because a page may not reach into `@/modules`,
 * and the preferences endpoint returns no flag saying which categories are
 * locked. If that list ever grows, this one has to follow — which is why the
 * rows below are driven by it rather than by hand-written markup per category.
 */
const MANDATORY_CATEGORIES: readonly string[] = ['emergency', 'security'];

const PRIORITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  normal: 'neutral',
  high: 'warning',
  critical: 'danger',
};

const PAGE_SIZE = 25;

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.getPage<Notification>(
        `/notifications?page=${page}&limit=${PAGE_SIZE}&unreadOnly=${unreadOnly}`,
      );
      setItems(result.items);
      setMeta(result.meta);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [page, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markRead(id: string) {
    // Flipped locally first: the list is the thing the resident is looking at,
    // and a full reload to grey out one row loses their scroll position.
    setItems(
      (current) =>
        current?.map((item) =>
          item.id === id ? { ...item, read: true, readAt: new Date().toISOString() } : item,
        ) ?? null,
    );

    try {
      await api.post(`/notifications/${id}/read`);
    } catch {
      void load();
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await api.post<{ marked: number }>('/notifications/read-all');
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function changeFilter(next: boolean) {
    setUnreadOnly(next);
    setPage(1);
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const unreadOnPage = items?.filter((item) => !item.read).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <Button
          variant="outline"
          onClick={() => void markAllRead()}
          disabled={items === null || unreadOnPage === 0}
          loading={busy}
          loadingText="Marking read"
        >
          <CheckCheck aria-hidden />
          Mark all read
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={unreadOnly ? 'outline' : 'primary'}
          onClick={() => changeFilter(false)}
        >
          All
        </Button>
        <Button
          size="sm"
          variant={unreadOnly ? 'primary' : 'outline'}
          onClick={() => changeFilter(true)}
        >
          Unread
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {items === null ? (
            <SkeletonTable rows={6} columns={3} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Bell aria-hidden />}
              variant={unreadOnly ? 'no-results' : 'empty'}
              title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
              description={
                unreadOnly
                  ? 'Everything the estate has sent you has been read.'
                  : 'Visitor arrivals, billing and estate notices will appear here.'
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onMarkRead={() => void markRead(notification.id)}
                />
              ))}
            </ul>
          )}

          {meta && meta.total > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
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
        </CardContent>
      </Card>

      <PreferencesCard />
    </div>
  );
}

function NotificationRow({
  notification,
  onMarkRead,
}: {
  notification: Notification;
  onMarkRead: () => void;
}) {
  const href = resolveHref(notification);

  return (
    <li
      className={cn('flex flex-wrap items-start gap-2 py-3', !notification.read && 'bg-muted/30')}
    >
      <span
        className={cn(
          'mt-2 size-2 shrink-0 rounded-full',
          notification.read ? 'bg-transparent' : 'bg-primary',
        )}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-sm', notification.read ? 'font-medium' : 'font-semibold')}>
            {href ? (
              <Link href={href} className="hover:underline">
                {notification.title}
              </Link>
            ) : (
              notification.title
            )}
          </span>

          <Badge tone="neutral" size="sm">
            {notification.category}
          </Badge>

          {notification.priority !== 'normal' && (
            <Badge tone={PRIORITY_TONE[notification.priority] ?? 'neutral'} size="sm" dot>
              {notification.priority}
            </Badge>
          )}

          {!notification.read && <span className="sr-only">Unread</span>}
        </div>

        <p className="text-muted-foreground mt-1 text-sm text-pretty">{notification.body}</p>
        <p className="text-muted-foreground mt-1 text-xs">{formatWhen(notification.createdAt)}</p>
      </div>

      {!notification.read && (
        <Button size="sm" variant="ghost" onClick={onMarkRead}>
          Mark read
        </Button>
      )}
    </li>
  );
}

/**
 * Where each resource lives in this app.
 *
 * Most notifications arrive with `actionUrl` null and only a resource pair, so
 * the link is derived from that rather than left off — "your visitor has
 * arrived" is worth nothing if it does not take you to the pass. A resource
 * with no screen of its own resolves to null and simply is not linked.
 */
const RESOURCE_ROUTES: Record<string, (id: string) => string | null> = {
  announcement: () => '/announcements',
  incident: (id) => `/admin/incidents/${id}`,
  emergency: () => '/security/emergencies',
  invoice: () => '/my/payments',
  payment: () => '/my/payments',
  visitor_pass: () => '/my/visitors',
};

/**
 * Where a notification points inside this app.
 *
 * The resource map is consulted before `actionUrl`, not after. Templates were
 * written against a `/portal/...` app that laid its screens out differently —
 * `announcement.published` points at `/portal/announcements/<id>`, which has no
 * counterpart here — so trusting the stored URL first would produce a link that
 * 404s. It is still used, normalised, for anything the map does not cover.
 *
 * Absolute URLs (verification, password reset) are deliberately not linked:
 * they belong to the email that carried them and do nothing useful from inside
 * a session that is already authenticated.
 */
function resolveHref(notification: Notification): string | null {
  const route = notification.resourceType ? RESOURCE_ROUTES[notification.resourceType] : undefined;
  const mapped = route?.(notification.resourceId ?? '');
  if (mapped) return mapped;

  const url = notification.actionUrl;
  if (!url?.startsWith('/') || url.startsWith('/portal/')) return null;

  return url;
}

function PreferencesCard() {
  const [preferences, setPreferences] = useState<Record<string, ChannelPreference> | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setPreferences(
        await api.get<Record<string, ChannelPreference>>('/notifications/preferences'),
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(category: string, channel: 'email' | 'sms', next: boolean) {
    const current = preferences?.[category];
    if (!current) return;

    setPreferences({ ...preferences, [category]: { ...current, [channel]: next } });
    setSaving(true);
    setProblem(null);

    try {
      // Only the changed category is sent. The endpoint merges, so sending the
      // whole map would overwrite a change made in another tab between the load
      // and this click.
      const stored = await api.patch<Record<string, ChannelPreference>>(
        '/notifications/preferences',
        { [category]: { [channel]: next } },
      );
      // What comes back is what was actually saved, not what was asked for.
      setPreferences(stored);
    } catch (caught) {
      setProblem(
        caught instanceof ApiRequestError ? caught.message : 'Could not save that preference.',
      );
      void load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>How you are contacted</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <ErrorState
            title="Preferences unavailable"
            description="Your notifications are unaffected; only these settings failed to load."
            onRetry={() => void load()}
          />
        ) : preferences === null ? (
          <SkeletonTable rows={7} columns={3} />
        ) : (
          <>
            {problem && <Alert tone="danger">{problem}</Alert>}

            <p className="text-muted-foreground text-sm text-pretty">
              Everything is always kept in this list, whatever you choose below — it is the record,
              not a channel. These settings control the copies sent by email and text message.
            </p>

            <ul className="divide-border divide-y">
              {Object.entries(preferences).map(([category, channels]) => {
                const locked = MANDATORY_CATEGORIES.includes(category);

                return (
                  <li key={category} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium capitalize">{category}</span>
                        {locked && (
                          <Badge tone="warning" size="sm">
                            <Lock className="size-3" aria-hidden />
                            always on
                          </Badge>
                        )}
                      </div>
                      {locked && (
                        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                          Safety alerts cannot be switched off — you must still hear about an
                          emergency months after silencing everything else.
                        </p>
                      )}
                    </div>

                    <div className="flex gap-4">
                      {(['email', 'sms'] as const).map((channel) => (
                        <label
                          key={channel}
                          className={cn(
                            'flex items-center gap-1.5 text-sm',
                            locked ? 'text-muted-foreground' : 'cursor-pointer',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="accent-primary size-4 shrink-0"
                            checked={channels[channel]}
                            disabled={locked || saving}
                            aria-label={`${channel} for ${category}`}
                            onChange={(event) =>
                              void toggle(category, channel, event.target.checked)
                            }
                          />
                          {channel === 'sms' ? 'SMS' : 'Email'}
                        </label>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const sameDay = new Date().toDateString() === date.toDateString();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
