'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  Filter,
  Lock,
  Search,
  UserCheck,
} from 'lucide-react';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonText, SkeletonTable } from '@/components/ui/skeleton';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The service request queue.
 *
 * The API already sorts by due date, but due date alone buries the tickets that
 * matter: a breached ticket and a ticket due next week sit in the same list and
 * read the same. So breached and escalated tickets are lifted into their own
 * block above the queue, and the queue below keeps the API's ordering.
 *
 * Each ticket carries its own actions — assign, the two working states,
 * resolve and close. They act in place rather than on a detail screen, because
 * the work here is triage: a supervisor moving eight tickets through the queue
 * should not pay for eight navigations. Every action refetches the page rather
 * than patching the row, since a transition changes fields the row does not
 * post — `assignedAt`, `overdue`, the resolution — and guessing at those is how
 * a queue starts lying about its own SLA.
 */
interface ServiceRequest {
  id: string;
  ticketNumber: string;
  category: string;
  priority: string;
  subject: string;
  status: string;
  assignedToMembershipId: string | null;
  assignedDepartment: string | null;
  dueAt: string;
  overdue: boolean;
  escalatedAt: string | null;
  createdAt: string;
}

interface StaffOption {
  membershipId: string;
  fullName: string;
  category: string;
  unitNumber: string | null;
}

const STATUSES = [
  'open',
  'assigned',
  'in-progress',
  'awaiting-resident',
  'resolved',
  'closed',
] as const;

const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

const CATEGORIES = [
  'security',
  'water',
  'electricity',
  'waste',
  'roads',
  'drainage',
  'streetlight',
  'maintenance',
  'noise',
  'other',
] as const;

const PRIORITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  open: 'info',
  assigned: 'info',
  'in-progress': 'warning',
  'awaiting-resident': 'warning',
  resolved: 'success',
  closed: 'neutral',
};

const PAGE_SIZE = 25;

export default function ServiceRequestsPage() {
  const [requests, setRequests] = useState<ServiceRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (category) params.set('category', category);
    if (overdueOnly) params.set('overdue', 'true');

    try {
      setRequests(await api.get<ServiceRequest[]>(`/service-requests?${params.toString()}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [page, status, priority, category, overdueOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One place for the refetch-and-report rule every ticket action shares. */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await action();
        await load();
      } catch (error) {
        setActionError(
          error instanceof ApiRequestError ? error.message : 'That did not go through.',
        );
      }
    },
    [load],
  );

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const breached = requests?.filter((request) => request.overdue || request.escalatedAt) ?? [];
  const queue = requests?.filter((request) => !request.overdue && !request.escalatedAt) ?? [];
  const filtered = Boolean(status || priority || category || overdueOnly);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Service requests</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {actionError && (
        <Alert tone="danger" title="The ticket was not changed">
          {actionError}
        </Alert>
      )}

      <Card>
        <CardContent className="space-y-3 p-4 pt-4">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
            <Filter className="size-3.5" aria-hidden />
            Filters
          </div>

          <FilterRow
            label="Status"
            options={STATUSES}
            value={status}
            onChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
          />
          <FilterRow
            label="Priority"
            options={PRIORITIES}
            value={priority}
            onChange={(next) => {
              setPriority(next);
              setPage(1);
            }}
          />
          <FilterRow
            label="Category"
            options={CATEGORIES}
            value={category}
            onChange={(next) => {
              setCategory(next);
              setPage(1);
            }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground w-16 shrink-0 text-xs">SLA</span>
            <Button
              size="sm"
              variant={overdueOnly ? 'primary' : 'outline'}
              onClick={() => {
                setOverdueOnly(!overdueOnly);
                setPage(1);
              }}
            >
              <AlertTriangle aria-hidden />
              Breached only
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Breached and escalated tickets are the reason anyone opens this page. */}
      {breached.length > 0 && (
        <Card className="border-danger">
          <CardHeader>
            <CardTitle className="text-danger flex items-center gap-2">
              <AlertTriangle className="size-5" aria-hidden />
              {breached.length} past its response target
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {breached.map((request) => (
              <TicketRow key={request.id} request={request} onRun={run} emphasis />
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
        </CardHeader>
        <CardContent>
          {requests === null ? (
            <SkeletonTable rows={6} columns={4} />
          ) : requests.length === 0 ? (
            <EmptyState
              variant={filtered ? 'no-results' : 'empty'}
              title={filtered ? 'Nothing matches those filters' : 'No open requests'}
              description={
                filtered
                  ? 'Clear a filter to widen the search.'
                  : 'Tickets raised by residents appear here.'
              }
            />
          ) : queue.length === 0 ? (
            <EmptyState
              title="Nothing else in the queue"
              description="Every ticket on this page is listed above as breached."
            />
          ) : (
            <ul className="divide-border divide-y">
              {queue.map((request) => (
                <li key={request.id} className="py-2.5">
                  <TicketRow request={request} onRun={run} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {requests !== null && (page > 1 || requests.length === PAGE_SIZE) && (
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground text-sm tabular-nums">Page {page}</span>
          <Button
            variant="outline"
            disabled={requests.length < PAGE_SIZE}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function TicketRow({
  request,
  onRun,
  emphasis = false,
}: {
  request: ServiceRequest;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
  emphasis?: boolean;
}) {
  return (
    <div className={cn(emphasis && 'bg-danger-muted rounded-lg p-3')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono text-xs">{request.ticketNumber}</span>
        <Badge tone={PRIORITY_TONE[request.priority] ?? 'neutral'} size="sm">
          {request.priority}
        </Badge>
        <Badge tone={STATUS_TONE[request.status] ?? 'neutral'} size="sm" dot>
          {request.status}
        </Badge>
        {request.escalatedAt && (
          <Badge tone="danger" size="sm">
            <ArrowUpCircle className="size-3" aria-hidden />
            escalated
          </Badge>
        )}
        <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs tabular-nums">
          <Clock className="size-3" aria-hidden />
          {request.overdue ? `${sinceDue(request.dueAt)} over` : `due ${untilDue(request.dueAt)}`}
        </span>
      </div>

      <p className="mt-1 text-sm font-medium">{request.subject}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">
        {request.category} · raised {formatDate(request.createdAt)}
        {request.assignedDepartment && ` · ${request.assignedDepartment}`}
      </p>

      <TicketActions request={request} onRun={onRun} />
    </div>
  );
}

/**
 * What can be done to this ticket right now.
 *
 * A closed ticket gets no controls at all rather than disabled ones: there is
 * nothing left to do to it, and a row of greyed buttons reads as a fault.
 */
function TicketActions({
  request,
  onRun,
}: {
  request: ServiceRequest;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState('');
  // Satisfaction is the resident's verdict, so it stays optional — a supervisor
  // closing a ticket nobody rated must not have to invent a number.
  const [rating, setRating] = useState('');

  if (request.status === 'closed') {
    return (
      <p className="text-muted-foreground mt-2 text-xs">
        Closed. Nothing further can be done to this ticket.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <AssignDialog
          ticketNumber={request.ticketNumber}
          onAssign={(body) =>
            onRun(() =>
              api.post(`/service-requests/${request.id}/assign`, body, {
                idempotencyKey: crypto.randomUUID(),
              }),
            )
          }
        />

        <Button
          size="sm"
          variant="outline"
          disabled={request.status === 'in-progress'}
          onClick={() =>
            void onRun(() =>
              api.post(`/service-requests/${request.id}/status`, { status: 'in-progress' }),
            )
          }
        >
          In progress
        </Button>

        <Button
          size="sm"
          variant="outline"
          disabled={request.status === 'awaiting-resident'}
          onClick={() =>
            void onRun(() =>
              api.post(`/service-requests/${request.id}/status`, { status: 'awaiting-resident' }),
            )
          }
        >
          Awaiting resident
        </Button>

        {request.status !== 'resolved' && (
          <Button size="sm" variant="success" onClick={() => setResolving(!resolving)}>
            <CheckCircle2 aria-hidden />
            Resolve
          </Button>
        )}

        <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
          Rating
          <select
            value={rating}
            onChange={(event) => setRating(event.target.value)}
            aria-label={`Satisfaction rating for ${request.ticketNumber}`}
            className="border-input bg-background focus-visible:ring-ring h-8 rounded-md border px-2 text-xs tabular-nums focus-visible:ring-2 focus-visible:outline-none"
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <ConfirmDialog
          trigger={
            <Button size="sm" variant="danger">
              <Lock aria-hidden />
              Close
            </Button>
          }
          title={`Close ${request.ticketNumber}?`}
          description={
            rating
              ? `The ticket is closed and recorded with a satisfaction rating of ${rating} out of 5. Closing is terminal.`
              : 'The ticket is closed with no satisfaction rating. Closing is terminal — pick a rating first if the resident gave one.'
          }
          confirmLabel="Close ticket"
          tone="danger"
          onConfirm={() =>
            onRun(() =>
              api.delete(
                `/service-requests/${request.id}${rating ? `?satisfactionRating=${rating}` : ''}`,
              ),
            )
          }
        />
      </div>

      {resolving && (
        <div className="space-y-2">
          <textarea
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            rows={2}
            aria-label={`Resolution for ${request.ticketNumber}`}
            placeholder="What was done, and what the outcome was."
            className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          <Button
            size="sm"
            variant="success"
            disabled={resolution.trim().length < 4}
            onClick={() =>
              void onRun(async () => {
                await api.post(
                  `/service-requests/${request.id}/resolve`,
                  { resolution: resolution.trim() },
                  { idempotencyKey: crypto.randomUUID() },
                );
                setResolution('');
                setResolving(false);
              })
            }
          >
            Save resolution
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Routing a ticket.
 *
 * A department on its own is a real state — a ticket can sit with Maintenance
 * before anyone is named — so either half is enough, which is exactly what the
 * route accepts. The person is chosen by name and never by id: a membership id
 * is opaque, and a mistyped one routes the ticket to a stranger.
 */
function AssignDialog({
  ticketNumber,
  onAssign,
}: {
  ticketNumber: string;
  onAssign: (body: { assigneeMembershipId?: string; department?: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [department, setDepartment] = useState('');
  const [results, setResults] = useState<StaffOption[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ status: 'active', limit: '10' });
      if (term.trim()) query.set('search', term.trim());

      api
        .get<StaffOption[]>(`/residents?${query.toString()}`)
        .then((items) => {
          if (!cancelled) setResults(items);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, term]);

  async function assign(body: { assigneeMembershipId?: string; department?: string }) {
    setBusy(true);
    try {
      await onAssign(body);
      setOpen(false);
      setTerm('');
      setDepartment('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <UserCheck aria-hidden />
          Assign
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign {ticketNumber}</DialogTitle>
          <DialogDescription>
            Route it to a department, to a person, or to both.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <Input
              label="Department"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              placeholder="Maintenance"
              autoComplete="off"
            />
          </div>
          <Button
            disabled={department.trim().length === 0}
            loading={busy}
            onClick={() => void assign({ department: department.trim() })}
          >
            Route
          </Button>
        </div>

        <Input
          label="Or a person"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Name or code"
          leadingIcon={<Search aria-hidden />}
          autoComplete="off"
        />

        <ul className="divide-border max-h-56 divide-y overflow-y-auto">
          {results === null ? (
            <li className="py-3">
              <SkeletonText lines={3} />
            </li>
          ) : results.length === 0 ? (
            <li className="text-muted-foreground py-3 text-sm">Nobody matches that.</li>
          ) : (
            results.map((person) => (
              <li key={person.membershipId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void assign({
                      assigneeMembershipId: person.membershipId,
                      ...(department.trim() ? { department: department.trim() } : {}),
                    })
                  }
                  className="hover:bg-accent focus-visible:ring-ring flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {person.fullName}
                  </span>
                  <Badge tone="neutral" size="sm">
                    {person.category}
                  </Badge>
                  {person.unitNumber && (
                    <span className="text-muted-foreground text-xs">{person.unitNumber}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground w-16 shrink-0 text-xs">{label}</span>
      <Button size="sm" variant={value === null ? 'primary' : 'ghost'} onClick={() => onChange(null)}>
        All
      </Button>
      {options.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={value === option ? 'primary' : 'ghost'}
          onClick={() => onChange(value === option ? null : option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function sinceDue(iso: string): string {
  return formatSpan(Date.now() - new Date(iso).getTime());
}

function untilDue(iso: string): string {
  const remaining = new Date(iso).getTime() - Date.now();
  return remaining <= 0 ? 'now' : `in ${formatSpan(remaining)}`;
}

function formatSpan(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
