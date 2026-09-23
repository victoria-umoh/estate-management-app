'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUpCircle,
  CheckCircle2,
  EyeOff,
  Lock,
  MapPin,
  MessageSquare,
  Search,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * One incident, and everything that can be done to it.
 *
 * The record and the thread are two requests, not one, and a failure in the
 * thread does not blank the record: a comment endpoint that is unhappy should
 * not take the report with it. Every lifecycle call refetches both rather than
 * patching state locally, because a transition can change fields this screen
 * does not post — severity moves on escalation, status moves on assign — and
 * guessing at those is how a screen starts lying.
 */
type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

type IncidentStatus = 'open' | 'assigned' | 'investigating' | 'resolved' | 'closed' | 'escalated';

interface Incident {
  id: string;
  reference: string;
  category: string;
  severity: IncidentSeverity;
  title: string;
  description: string;
  status: IncidentStatus;
  location: string | null;
  propertyId: string | null;
  occurredAt: string;
  reportedByMembershipId: string;
  involvedPersons: Array<{ label: string; membershipId: string | null }>;
  involvedVehicles: Array<{ plate: string; vehicleId: string | null }>;
  attachmentIds: string[];
  assignedToMembershipId: string | null;
  assignedAt: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  resolvedByMembershipId: string | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface IncidentComment {
  id: string;
  incidentId: string;
  authorMembershipId: string;
  body: string;
  internal: boolean;
  attachmentIds: string[];
  createdAt: string;
}

interface StaffOption {
  membershipId: string;
  fullName: string;
  category: string;
  unitNumber: string | null;
}

const SEVERITY_TONE: Record<IncidentSeverity, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const STATUS_TONE: Record<IncidentStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'warning',
  assigned: 'info',
  investigating: 'info',
  escalated: 'danger',
  resolved: 'success',
  closed: 'neutral',
};

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [incident, setIncident] = useState<Incident | null>(null);
  const [comments, setComments] = useState<IncidentComment[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'denied' | 'failed'>(
    'loading',
  );
  const [commentsFailed, setCommentsFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadComments = useCallback(async () => {
    if (!id) return;
    try {
      setComments(await api.get<IncidentComment[]>(`/incidents/${id}/comments`));
      setCommentsFailed(false);
    } catch {
      setCommentsFailed(true);
    }
  }, [id]);

  const load = useCallback(async () => {
    if (!id) return;

    try {
      setIncident(await api.get<Incident>(`/incidents/${id}`));
      setState('ready');
    } catch (error) {
      // A missing incident and a forbidden one are different answers and get
      // different screens; anything else is a failure worth retrying.
      if (error instanceof ApiRequestError && error.status === 404) setState('missing');
      else if (error instanceof ApiRequestError && error.status === 403) setState('denied');
      else setState('failed');
      return;
    }

    await loadComments();
  }, [id, loadComments]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every action funnels through here so one refetch rule covers all of them. */
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

  if (state === 'failed') return <ErrorState onRetry={() => void load()} />;
  if (state === 'denied') return <PermissionDeniedState action="view this incident" />;

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" className="-ml-2" asChild>
        <Link href="/admin/incidents">
          <ArrowLeft aria-hidden />
          All incidents
        </Link>
      </Button>

      {state === 'loading' || incident === null ? (
        <Card>
          <CardContent className="p-4 pt-4">
            <SkeletonText lines={5} />
          </CardContent>
        </Card>
      ) : state === 'missing' ? (
        <EmptyState
          variant="no-results"
          title="Incident not found"
          description="It may have been closed off to another estate, or the reference may be wrong."
          action={
            <Button variant="outline" asChild>
              <Link href="/admin/incidents">Back to incidents</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                tone={SEVERITY_TONE[incident.severity]}
                dot
                pulse={incident.severity === 'critical'}
              >
                {incident.severity}
              </Badge>
              <Badge tone={STATUS_TONE[incident.status]}>{incident.status}</Badge>
              <Badge tone="neutral">{incident.category}</Badge>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {incident.reference}
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-balance">{incident.title}</h1>
          </div>

          {actionError && (
            <Alert tone="danger" title="Nothing was changed">
              {actionError}
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Report</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm whitespace-pre-wrap">{incident.description}</p>

              <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                <Field label="Occurred">{formatDateTime(incident.occurredAt)}</Field>
                <Field label="Location">
                  {incident.location ? (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="text-muted-foreground size-3.5" aria-hidden />
                      {incident.location}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not recorded</span>
                  )}
                </Field>
                <Field label="Assigned to">
                  {incident.assignedToMembershipId ? (
                    <span className="inline-flex items-center gap-1.5">
                      <UserCheck className="text-muted-foreground size-3.5" aria-hidden />
                      <span className="font-mono text-xs">{incident.assignedToMembershipId}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Nobody yet</span>
                  )}
                </Field>
                <Field label="Reported by">
                  <span className="font-mono text-xs">{incident.reportedByMembershipId}</span>
                </Field>

                {incident.involvedPersons.length > 0 && (
                  <Field label="People named">
                    {incident.involvedPersons.map((person) => person.label).join(', ')}
                  </Field>
                )}
                {incident.involvedVehicles.length > 0 && (
                  <Field label="Vehicles named">
                    <span className="font-mono text-xs">
                      {incident.involvedVehicles.map((vehicle) => vehicle.plate).join(', ')}
                    </span>
                  </Field>
                )}
                {incident.attachmentIds.length > 0 && (
                  <Field label="Attachments">{incident.attachmentIds.length}</Field>
                )}
              </dl>

              {incident.escalatedAt && (
                <Alert tone="danger" title={`Escalated ${formatDateTime(incident.escalatedAt)}`}>
                  {incident.escalationReason ?? 'No reason recorded.'}
                </Alert>
              )}

              {incident.resolution && (
                <Alert tone="success" title="Resolution">
                  {incident.resolution}
                  {incident.resolvedAt && (
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {formatDateTime(incident.resolvedAt)}
                    </span>
                  )}
                </Alert>
              )}
            </CardContent>
          </Card>

          <Actions incident={incident} onRun={run} />

          <Thread
            comments={comments}
            failed={commentsFailed}
            onRetry={() => void loadComments()}
            onPost={async (body, internal) => {
              await api.post(`/incidents/${incident.id}/comments`, { body, internal });
              await loadComments();
            }}
          />
        </>
      )}
    </div>
  );
}

function Actions({
  incident,
  onRun,
}: {
  incident: Incident;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [resolution, setResolution] = useState('');
  const [reason, setReason] = useState('');

  const closed = incident.status === 'closed';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {closed ? (
          <p className="text-muted-foreground text-sm">
            This incident is closed. Closed is terminal: reopening means raising a new incident that
            references this one, so the record stays intact.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <AssignDialog
                onAssign={(membershipId) =>
                  onRun(() =>
                    api.post(
                      `/incidents/${incident.id}/assign`,
                      { assigneeMembershipId: membershipId },
                      { idempotencyKey: crypto.randomUUID() },
                    ),
                  )
                }
              />

              <Button
                variant="outline"
                disabled={incident.status === 'investigating'}
                onClick={() =>
                  void onRun(() =>
                    api.post(`/incidents/${incident.id}/status`, { status: 'investigating' }),
                  )
                }
              >
                <Search aria-hidden />
                Investigating
              </Button>

              <Button
                variant="outline"
                disabled={incident.status === 'open'}
                onClick={() =>
                  void onRun(() => api.post(`/incidents/${incident.id}/status`, { status: 'open' }))
                }
              >
                Back to open
              </Button>

              <ConfirmDialog
                trigger={
                  <Button variant="danger">
                    <Lock aria-hidden />
                    Close
                  </Button>
                }
                title="Close this incident?"
                description="Closing is terminal. Nothing is deleted, but the incident can no longer be assigned, investigated or resolved — reopening means raising a new one that references this."
                confirmLabel="Close incident"
                tone="danger"
                onConfirm={() => onRun(() => api.delete(`/incidents/${incident.id}`))}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label
                  className="text-foreground block text-sm font-medium"
                  htmlFor="incident-resolution"
                >
                  Resolution
                </label>
                <textarea
                  id="incident-resolution"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  rows={3}
                  placeholder="What was done, and what the outcome was."
                  className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                />
                <Button
                  variant="success"
                  disabled={resolution.trim().length < 4}
                  onClick={() =>
                    void onRun(async () => {
                      await api.post(
                        `/incidents/${incident.id}/resolve`,
                        { resolution: resolution.trim() },
                        { idempotencyKey: crypto.randomUUID() },
                      );
                      setResolution('');
                    })
                  }
                >
                  <CheckCircle2 aria-hidden />
                  Resolve
                </Button>
              </div>

              <div className="space-y-2">
                <label
                  className="text-foreground block text-sm font-medium"
                  htmlFor="incident-escalation-reason"
                >
                  Escalation reason
                </label>
                <textarea
                  id="incident-escalation-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  placeholder="Why this needs to go up."
                  className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                />
                {/* The reason is typed before confirming rather than in the
                    dialog: escalation raises severity, and the confirm step is
                    there to make the person read back what they wrote. */}
                <ConfirmDialog
                  trigger={
                    <Button variant="danger" disabled={reason.trim().length < 4}>
                      <ArrowUpCircle aria-hidden />
                      Escalate
                    </Button>
                  }
                  title="Escalate this incident?"
                  description={`Severity is raised and the reason is written to the record: "${reason.trim()}"`}
                  confirmLabel="Escalate"
                  tone="danger"
                  onConfirm={() =>
                    onRun(async () => {
                      await api.post(
                        `/incidents/${incident.id}/escalate`,
                        { reason: reason.trim() },
                        { idempotencyKey: crypto.randomUUID() },
                      );
                      setReason('');
                    })
                  }
                />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Picks the assignee by name.
 *
 * The membership id is never typed by hand — it is an opaque object id, and a
 * mistyped one assigns the incident to a stranger — so the search resolves it.
 */
function AssignDialog({ onAssign }: { onAssign: (membershipId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <UserCheck aria-hidden />
          Assign
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign this incident</DialogTitle>
          <DialogDescription>
            Search by name or resident code. Assigning moves the incident to assigned.
          </DialogDescription>
        </DialogHeader>

        <Input
          label="Who"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Name or code"
          leadingIcon={<Search aria-hidden />}
          autoComplete="off"
        />

        <ul className="divide-border max-h-64 divide-y overflow-y-auto">
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
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onAssign(person.membershipId);
                      setOpen(false);
                      setTerm('');
                    } finally {
                      setBusy(false);
                    }
                  }}
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

/**
 * The comment thread.
 *
 * An internal note is marked hard — tone, border, icon and a sentence — rather
 * than with a quiet tag. A staff member scanning the thread has to be able to
 * tell at a glance what the reporter can read back, because that judgement is
 * the whole reason the flag exists. The composer offers the flag to everyone:
 * the service downgrades it for a resident, and the posted comment comes back
 * saying which it was, so the thread shows the truth rather than the intent.
 */
function Thread({
  comments,
  failed,
  onRetry,
  onPost,
}: {
  comments: IncidentComment[] | null;
  failed: boolean;
  onRetry: () => void;
  onPost: (body: string, internal: boolean) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onPost(body.trim(), internal);
      setBody('');
      setInternal(false);
    } catch (postError) {
      setError(
        postError instanceof ApiRequestError ? postError.message : 'The comment was not posted.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-4" aria-hidden />
          Thread
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <ErrorState
            title="The thread could not be loaded"
            description="The incident above is still accurate."
            onRetry={onRetry}
          />
        ) : comments === null ? (
          <SkeletonText lines={4} />
        ) : comments.length === 0 ? (
          <EmptyState
            title="Nothing said yet"
            description="Notes on this incident appear here, newest last."
          />
        ) : (
          <ul className="space-y-3">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className={cn(
                  'rounded-lg border p-3',
                  comment.internal ? 'border-warning/35 bg-warning-muted' : 'border-border',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {comment.internal && (
                    <Badge tone="warning" size="sm">
                      <EyeOff className="size-3" aria-hidden />
                      Internal note
                    </Badge>
                  )}
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {comment.authorMembershipId}
                  </span>
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                    {formatDateTime(comment.createdAt)}
                  </span>
                </div>
                {comment.internal && (
                  <p className="text-warning mt-1 text-xs">
                    Staff only — the person who reported this incident cannot see it.
                  </p>
                )}
                <p className="text-foreground mt-1.5 text-sm whitespace-pre-wrap">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t pt-4">
          <label className="text-foreground block text-sm font-medium" htmlFor="incident-comment">
            Add a comment
          </label>
          <textarea
            id="incident-comment"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />

          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={internal}
              onChange={(event) => setInternal(event.target.checked)}
              className="accent-primary size-4"
            />
            <span className="inline-flex items-center gap-1.5">
              <EyeOff className="text-muted-foreground size-3.5" aria-hidden />
              Internal note
            </span>
            <span className="text-muted-foreground text-xs">
              Hidden from the reporter. Staff only — posted as an ordinary comment otherwise.
            </span>
          </label>

          {error && <Alert tone="danger">{error}</Alert>}

          <Button onClick={() => void submit()} disabled={body.trim().length === 0} loading={busy}>
            Post
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
