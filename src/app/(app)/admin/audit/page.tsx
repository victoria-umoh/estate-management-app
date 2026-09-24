'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { ExportButton } from '@/components/ui/export-button';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * The audit trail.
 *
 * Read-only throughout, because the trail itself is append-only: the API offers
 * no POST, PATCH or DELETE and the collection is frozen at the schema. So this
 * screen deliberately carries no row actions at all — an "edit" affordance that
 * could never work would misrepresent what the trail is for.
 *
 * Sensitive fields are reduced to a marker server-side before they reach here.
 * Those markers are rendered as badges rather than left to look like blank
 * values, so "we are not showing you this" reads differently from "nothing was
 * recorded".
 *
 * The API returns pagination in the envelope's `meta`, which the client drops,
 * so "is there a next page" is inferred from a full page coming back. It is one
 * wasted click at an exact multiple of the page size, which is cheaper than a
 * second request purely to count.
 */
interface AuditChange {
  field: string;
  from: unknown;
  to: unknown;
}

interface AuditEntry {
  _id: string;
  actorId: string | null;
  actorLabel: string;
  actorRoles: string[];
  action: string;
  resource: string;
  resourceId: string | null;
  outcome: 'success' | 'failure';
  reason: string | null;
  changes?: AuditChange[];
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
  createdAt: string;
}

interface Filters {
  action: string;
  resource: string;
  from: string;
  to: string;
}

const PAGE_SIZE = 25;
const EMPTY_FILTERS: Filters = { action: '', resource: '', from: '', to: '' };

/** Markers the audit diff uses in place of a value it will not store. */
const MARKERS = new Set(['[REDACTED]', '[SET]', '[CLEARED]']);

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [page, setPage] = useState(1);
  // Applied separately from the draft so typing does not fire a request per
  // keystroke against a collection that only grows.
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  // The audit export is an Enterprise feature. Without this the button renders
  // for every estate and answers 402 on a plan that does not include it, which
  // is a worse experience than not offering it.
  const [canExport, setCanExport] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const plan = await api.get<{ features?: string[] }>('/subscription');
        setCanExport(Boolean(plan.features?.includes('audit-export')));
      } catch {
        // Subscription is a separate permission from audit.view, so a reader
        // who cannot see the plan simply is not offered the export.
        setCanExport(false);
      }
    })();
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (applied.action) params.set('action', applied.action);
    if (applied.resource) params.set('resource', applied.resource);
    if (applied.from) params.set('from', applied.from);
    // An inclusive end date: the picker gives a day, people mean the whole day.
    if (applied.to) params.set('to', `${applied.to}T23:59:59.999Z`);

    setEntries(null);

    try {
      setEntries(await api.get<AuditEntry[]>(`/audit?${params.toString()}`));
      setFailed(false);
      setDenied(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, [page, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilters() {
    setPage(1);
    setApplied(draft);
  }

  function clearFilters() {
    setPage(1);
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  }

  if (denied) return <PermissionDeniedState action="view the audit trail" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  const filtering = Object.values(applied).some(Boolean);
  const hasNextPage = entries !== null && entries.length === PAGE_SIZE;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Audit trail</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Lock className="size-3.5" aria-hidden />
            Append-only — entries cannot be edited or removed
          </span>
          {/* The export names the fields that changed and never their values,
              so this cannot become a way to read a NIN out of a diff. */}
          {canExport && (
            <ExportButton
              path="/audit/export"
              filters={{
                action: applied.action,
                resource: applied.resource,
                from: applied.from,
                to: applied.to,
              }}
            />
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filter</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              label="Action"
              placeholder="resident.approved"
              value={draft.action}
              onChange={(event) => setDraft({ ...draft, action: event.target.value })}
            />
            <Input
              label="Resource"
              placeholder="resident"
              value={draft.resource}
              onChange={(event) => setDraft({ ...draft, resource: event.target.value })}
            />
            <Input
              label="From"
              type="date"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
            <Input
              label="To"
              type="date"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={applyFilters}>Apply</Button>
            <Button
              variant="ghost"
              onClick={clearFilters}
              disabled={!filtering && !hasDraft(draft)}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entries</CardTitle>
        </CardHeader>
        <CardContent>
          {entries === null ? (
            <SkeletonTable rows={8} columns={4} />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<ScrollText aria-hidden />}
              variant={filtering ? 'no-results' : 'empty'}
              title={filtering ? 'Nothing matches those filters' : 'No entries yet'}
              description={
                filtering
                  ? 'Try widening the date range or clearing a field.'
                  : 'Actions taken in this estate are recorded here as they happen.'
              }
              {...(filtering
                ? {
                    action: (
                      <Button variant="outline" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : (
            <ul className="divide-border divide-y">
              {entries.map((entry) => {
                const open = expanded === entry._id;
                const changes = entry.changes ?? [];

                return (
                  <li key={entry._id} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {changes.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : entry._id)}
                          aria-expanded={open}
                          className="text-muted-foreground hover:text-foreground -ml-1 rounded p-1"
                        >
                          {open ? (
                            <ChevronDown className="size-4" aria-hidden />
                          ) : (
                            <ChevronRight className="size-4" aria-hidden />
                          )}
                          <span className="sr-only">
                            {open ? 'Hide' : 'Show'} changes for {entry.action}
                          </span>
                        </button>
                      ) : (
                        <span className="size-6 shrink-0" aria-hidden />
                      )}

                      <span className="font-mono text-sm font-medium break-all">
                        {entry.action}
                      </span>

                      <Badge
                        tone={entry.outcome === 'success' ? 'success' : 'danger'}
                        size="sm"
                        dot
                      >
                        {entry.outcome}
                      </Badge>

                      {changes.length > 0 && (
                        <Badge tone="neutral" size="sm">
                          {changes.length} {changes.length === 1 ? 'change' : 'changes'}
                        </Badge>
                      )}

                      <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                        {formatMoment(entry.createdAt)}
                      </span>
                    </div>

                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs">
                      <span className="text-foreground">{entry.actorLabel}</span>
                      {entry.actorRoles.length > 0 && <span>{entry.actorRoles.join(', ')}</span>}
                      <span>
                        {entry.resource}
                        {entry.resourceId ? ` · ${entry.resourceId}` : ''}
                      </span>
                      {entry.ip && <span className="font-mono tabular-nums">{entry.ip}</span>}
                    </div>

                    {entry.reason && (
                      <p className="text-danger mt-1 pl-6 text-xs">{entry.reason}</p>
                    )}

                    {open && changes.length > 0 && (
                      <ul className="bg-muted mt-2 ml-6 space-y-1.5 rounded-lg p-3">
                        {changes.map((change, index) => (
                          <li
                            key={`${change.field}-${index}`}
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
                          >
                            <span className="text-foreground font-medium">{change.field}</span>
                            <DiffValue value={change.from} />
                            <span className="text-muted-foreground" aria-label="changed to">
                              →
                            </span>
                            <DiffValue value={change.to} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" onClick={() => setPage(page - 1)} disabled={page === 1}>
          Previous
        </Button>
        <span className="text-muted-foreground text-sm tabular-nums">Page {page}</span>
        <Button variant="outline" onClick={() => setPage(page + 1)} disabled={!hasNextPage}>
          Next
        </Button>
      </div>
    </div>
  );
}

/**
 * One side of a field change.
 *
 * A redaction marker is shown as a badge rather than as text, so it cannot be
 * mistaken for the value that was actually stored.
 */
function DiffValue({ value }: { value: unknown }) {
  if (typeof value === 'string' && MARKERS.has(value)) {
    return (
      <Badge tone="info" size="sm">
        {value === '[REDACTED]' ? 'redacted' : value === '[SET]' ? 'set' : 'cleared'}
      </Badge>
    );
  }

  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">empty</span>;
  }

  return (
    <span className="text-muted-foreground font-mono break-all">
      {typeof value === 'string' ? value : JSON.stringify(value)}
    </span>
  );
}

function hasDraft(draft: Filters): boolean {
  return Object.values(draft).some(Boolean);
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
