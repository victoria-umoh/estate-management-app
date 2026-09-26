'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, ChevronRight, Clock, Plus, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api, type PageMeta } from '@/lib/api/client';

/**
 * The service requests this resident has raised.
 *
 * The list is the same `/service-requests` route staff use. It needs no filter
 * from here: without `serviceRequest.viewAll` the server narrows it to tickets
 * the caller raised, and applies that narrowing after any filter the client
 * sends — so this screen could not widen it even by mistake.
 *
 * Priority is offered, not defaulted to urgent. It sets the response target
 * the estate is measured against, and the hint under each option says what
 * that target is, so the choice is an informed one rather than a reflex.
 */
interface ServiceRequestSummary {
  id: string;
  ticketNumber: string;
  category: string;
  priority: string;
  subject: string;
  status: string;
  dueAt: string;
  overdue: boolean;
  escalatedAt: string | null;
  createdAt: string;
}

const CATEGORIES = [
  ['maintenance', 'Maintenance'],
  ['water', 'Water'],
  ['electricity', 'Electricity'],
  ['waste', 'Waste collection'],
  ['roads', 'Roads'],
  ['drainage', 'Drainage'],
  ['streetlight', 'Streetlight'],
  ['security', 'Security'],
  ['noise', 'Noise'],
  ['other', 'Something else'],
] as const;

/** Mirrors the service's response targets, so the form can state them. */
const PRIORITIES = [
  ['low', 'Low', 'within a week'],
  ['normal', 'Normal', 'within 3 days'],
  ['high', 'High', 'within 24 hours'],
  ['urgent', 'Urgent', 'within 4 hours'],
] as const;

const STATUS_FILTERS = [
  ['', 'All'],
  ['open', 'Open'],
  ['in-progress', 'In progress'],
  ['awaiting-resident', 'Needs you'],
  ['resolved', 'Resolved'],
  ['closed', 'Closed'],
] as const;

const PRIORITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = {
  open: 'info',
  assigned: 'info',
  'in-progress': 'warning',
  'awaiting-resident': 'warning',
  resolved: 'success',
  closed: 'neutral',
};

const PAGE_SIZE = 20;

export default function MyRequestsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<ServiceRequestSummary[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (status) query.set('status', status);

      const result = await api.getPage<ServiceRequestSummary>(`/service-requests?${query}`);
      setRequests(result.items);
      setMeta(result.meta);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">My requests</h1>
        <NewRequestDialog
          onCreated={(created) => {
            toast.success(`Ticket ${created.ticketNumber} raised`);
            // Straight to the ticket: that is where photographs are attached,
            // and a ticket must exist before anything can be attached to it.
            router.push(`/my/requests/${created.id}`);
          }}
        />
      </div>

      <div
        role="group"
        aria-label="Filter by status"
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {STATUS_FILTERS.map(([value, label]) => (
          <button
            key={value || 'all'}
            type="button"
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
              setPage(1);
              setRequests(null);
            }}
            className={
              status === value
                ? 'bg-primary text-primary-foreground focus-visible:ring-ring shrink-0 rounded-full px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none'
                : 'bg-muted text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Tickets
            {meta && meta.total > 0 && (
              <span className="text-muted-foreground ml-2 text-sm font-normal tabular-nums">
                {meta.total}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {requests === null ? (
            <SkeletonTable rows={4} columns={2} />
          ) : requests.length === 0 ? (
            <EmptyState
              icon={<Wrench aria-hidden />}
              title={status ? 'Nothing with that status' : 'No requests yet'}
              description="Report a burst pipe, a dead streetlight or uncollected waste, and follow it here until it is fixed."
            />
          ) : (
            <ul className="divide-border -mx-2 divide-y">
              {requests.map((request) => (
                <li key={request.id}>
                  <Link
                    href={`/my/requests/${request.id}`}
                    className="hover:bg-muted/60 focus-visible:ring-ring flex items-center gap-3 rounded-md px-2 py-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{request.subject}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={STATUS_TONE[request.status] ?? 'neutral'} size="sm" dot>
                          {request.status === 'awaiting-resident'
                            ? 'waiting on you'
                            : request.status}
                        </Badge>
                        <Badge tone={PRIORITY_TONE[request.priority] ?? 'neutral'} size="sm">
                          {request.priority}
                        </Badge>
                        {request.escalatedAt && (
                          <Badge tone="danger" size="sm">
                            <ArrowUpCircle className="size-3" aria-hidden />
                            escalated
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                        <span className="font-mono">{request.ticketNumber}</span>
                        <span>{categoryLabel(request.category)}</span>
                        {!['resolved', 'closed'].includes(request.status) && (
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <Clock className="size-3" aria-hidden />
                            {request.overdue ? 'past target' : `due ${formatWhen(request.dueAt)}`}
                          </span>
                        )}
                      </p>
                    </div>
                    <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {meta && meta.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1 || requests === null}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <span className="text-muted-foreground text-xs tabular-nums">
                Page {meta.page} of {meta.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={requests === null || !meta.hasNextPage}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NewRequestDialog({
  onCreated,
}: {
  onCreated: (created: { id: string; ticketNumber: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [priority, setPriority] = useState<string>('normal');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();

    try {
      const created = await api.post<{ id: string; ticketNumber: string; dueAt: string }>(
        '/service-requests',
        {
          category: text('category'),
          priority,
          subject: text('subject'),
          description: text('description'),
          // Omitted rather than sent blank; the property is not sent at all,
          // since the ticket is already tied to the caller's own membership.
          ...(text('location') ? { location: text('location') } : {}),
        },
      );

      setOpen(false);
      setPriority('normal');
      onCreated(created);
    } catch (error) {
      setProblem(
        error instanceof ApiRequestError && error.status === 429
          ? 'You have raised a lot of requests in the last hour. Please wait a little and try again.'
          : error instanceof ApiRequestError && error.status < 500
            ? error.message
            : 'Could not raise the request. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          New request
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Raise a service request</DialogTitle>
          <DialogDescription>
            The estate office is notified and you can follow progress here. You can attach photos
            once it is raised.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          <label className="block space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              What is it about?
              <span className="text-danger ml-0.5" aria-label="required">
                *
              </span>
            </span>
            <select
              name="category"
              required
              defaultValue=""
              className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <option value="" disabled>
                Choose a category
              </option>
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <Input
            name="subject"
            label="Short summary"
            required
            minLength={4}
            maxLength={160}
            placeholder="e.g. Streetlight out outside No. 14"
          />

          <label className="block space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              Details
              <span className="text-danger ml-0.5" aria-label="required">
                *
              </span>
            </span>
            <textarea
              name="description"
              required
              minLength={4}
              maxLength={5000}
              rows={4}
              placeholder="What is wrong, since when, and anything that would help someone fix it."
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </label>

          <Input
            name="location"
            label="Where exactly?"
            maxLength={200}
            hint="Optional — leave blank if it is at your home"
          />

          <fieldset className="space-y-1.5">
            <legend className="text-foreground mb-1.5 block text-sm font-medium">
              How urgent is it?
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {PRIORITIES.map(([value, label, target]) => (
                <label
                  key={value}
                  className="has-[:checked]:border-primary has-[:checked]:bg-primary-muted has-[:focus-visible]:ring-ring flex cursor-pointer flex-col rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2"
                >
                  <input
                    type="radio"
                    name="priority"
                    value={value}
                    checked={priority === value}
                    onChange={() => setPriority(value)}
                    className="sr-only"
                  />
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground text-xs">{target}</span>
                </label>
              ))}
            </div>
            {priority === 'urgent' && (
              <p className="text-muted-foreground text-xs">
                For danger to life or property right now, use the emergency button on the Safety
                screen instead — it reaches security immediately.
              </p>
            )}
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Raise request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function categoryLabel(category: string): string {
  return CATEGORIES.find(([value]) => value === category)?.[1] ?? category;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
