'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, MapPin, MessageSquare, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Attachments } from '@/components/feature/attachments';
import { ApiRequestError, api } from '@/lib/api/client';
import { useProfile } from '@/lib/hooks/use-profile';

/**
 * An incident the resident reported, or was named in.
 *
 * The server answers anyone else's incident with the same 404 as a missing one,
 * and withholds internal staff notes from the thread, so nothing here filters —
 * it renders what it is given.
 *
 * Unlike a service request, the resident has no last word here: resolving and
 * closing belong to the estate office, so the screen reports where the case
 * stands and offers only the conversation and the photographs.
 */
interface Incident {
  id: string;
  reference: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  status: string;
  location: string | null;
  occurredAt: string;
  resolution: string | null;
  resolvedAt: string | null;
  escalatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface Comment {
  id: string;
  body: string;
  authorMembershipId: string;
  createdAt: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  open: 'info',
  assigned: 'info',
  investigating: 'warning',
  escalated: 'danger',
  resolved: 'success',
  closed: 'neutral',
};

const SEVERITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

const CATEGORY_LABEL: Record<string, string> = {
  'suspicious-activity': 'Suspicious activity',
  theft: 'Theft',
  'security-breach': 'Security breach',
  'property-damage': 'Property damage',
  noise: 'Noise',
  parking: 'Parking',
  power: 'Power',
  water: 'Water',
  flood: 'Flood',
  fire: 'Fire',
  medical: 'Medical',
  accident: 'Accident',
  other: 'Something else',
};

export default function MyIncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { profile } = useProfile();

  const [incident, setIncident] = useState<Incident | null>(null);
  const [failed, setFailed] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  // 'withheld' is a resident named in someone else's report: they may read the
  // incident, but its conversation is between the reporter and the office.
  const [commentsState, setCommentsState] = useState<'ok' | 'failed' | 'withheld'>('ok');

  const load = useCallback(async () => {
    try {
      setIncident(await api.get<Incident>(`/incidents/${id}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  const loadComments = useCallback(async () => {
    try {
      setComments(await api.get<Comment[]>(`/incidents/${id}/comments`));
      setCommentsState('ok');
    } catch (error) {
      setCommentsState(
        error instanceof ApiRequestError && error.status === 403 ? 'withheld' : 'failed',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
    void loadComments();
  }, [load, loadComments]);

  if (failed) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState
          title="Incident not found"
          description="It may have been removed, or the link is wrong."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  const closed = incident?.status === 'closed';

  return (
    <div className="space-y-5">
      <BackLink />

      {incident === null ? (
        <SkeletonTable rows={6} columns={2} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground font-mono text-xs">
                  {incident.reference}
                </span>
                <Badge tone={STATUS_TONE[incident.status] ?? 'neutral'} size="sm" dot>
                  {incident.status}
                </Badge>
                <Badge tone={SEVERITY_TONE[incident.severity] ?? 'neutral'} size="sm">
                  {incident.severity}
                </Badge>
              </div>
              <CardTitle className="text-balance">{incident.title}</CardTitle>
            </CardHeader>

            <CardContent className="space-y-4">
              {incident.status === 'escalated' && (
                <Alert tone="warning" title="Passed to senior staff">
                  The estate office has escalated this incident and is following it up.
                </Alert>
              )}

              <p className="text-sm whitespace-pre-wrap">{incident.description}</p>

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                <Field label="Category">
                  {CATEGORY_LABEL[incident.category] ?? incident.category}
                </Field>
                <Field label="Happened">{formatDateTime(incident.occurredAt)}</Field>
                <Field label="Reported">{formatDateTime(incident.createdAt)}</Field>
                {incident.location && (
                  <Field label="Location">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="size-3.5" aria-hidden />
                      {incident.location}
                    </span>
                  </Field>
                )}
                {incident.closedAt && (
                  <Field label="Closed">{formatDateTime(incident.closedAt)}</Field>
                )}
              </dl>

              {incident.resolution && (
                <Alert tone="success" title="Resolved by the estate office">
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

          {/* A closed incident still shows its files but takes no more. */}
          <Attachments subjectType="incident" subjectId={incident.id} canUpload={!closed} />

          <Thread
            comments={comments}
            state={commentsState}
            closed={closed}
            me={profile?.membershipId ?? null}
            onRetry={() => void loadComments()}
            onPost={async (body) => {
              await api.post(`/incidents/${incident.id}/comments`, { body });
              await loadComments();
            }}
          />
        </>
      )}
    </div>
  );
}

function Thread({
  comments,
  state,
  closed,
  me,
  onRetry,
  onPost,
}: {
  comments: Comment[] | null;
  state: 'ok' | 'failed' | 'withheld';
  closed: boolean;
  me: string | null;
  onRetry: () => void;
  onPost: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;

    setBusy(true);
    setProblem(null);

    try {
      await onPost(body.trim());
      setBody('');
    } catch {
      setProblem('That message could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-4" aria-hidden />
          Conversation
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {state === 'withheld' ? (
          <EmptyState
            icon={<ShieldAlert aria-hidden />}
            title="Between the reporter and the office"
            description="You were named in this incident, so you can see it, but its conversation is kept to the person who reported it."
          />
        ) : state === 'failed' ? (
          <ErrorState onRetry={onRetry} />
        ) : comments === null ? (
          <SkeletonTable rows={2} columns={1} />
        ) : comments.length === 0 ? (
          <EmptyState
            title="No messages yet"
            description="Updates from the estate office, and anything you add, appear here."
          />
        ) : (
          <ul aria-label="Messages" className="space-y-3">
            {comments.map((comment) => {
              const mine = me !== null && comment.authorMembershipId === me;
              return (
                <li
                  key={comment.id}
                  className={
                    mine ? 'bg-primary-muted ml-6 rounded-lg p-3' : 'bg-muted mr-6 rounded-lg p-3'
                  }
                >
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="font-medium">{mine ? 'You' : 'Estate office'}</span>
                    <span className="text-muted-foreground ml-auto tabular-nums">
                      {formatDateTime(comment.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
                </li>
              );
            })}
          </ul>
        )}

        {/*
         * Closed is terminal: anything new about it is a new report, so the
         * finished case's record stays as it was when it was closed.
         */}
        {state === 'ok' && !closed && (
          <form onSubmit={submit} className="space-y-2 border-t pt-3">
            {problem && <Alert tone="danger">{problem}</Alert>}

            <label className="block space-y-1.5">
              <span className="text-foreground block text-sm font-medium">Add a message</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="Answer a question, or add anything you have remembered since"
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              />
            </label>

            <div className="flex justify-end">
              <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
                Send
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Link
      href="/my/safety"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Safety
    </Link>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
