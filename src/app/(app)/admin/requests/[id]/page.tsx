'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpCircle, Clock, EyeOff, MapPin, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { Attachments } from '@/components/feature/attachments';
import { api } from '@/lib/api/client';

/**
 * One service request.
 *
 * The list already carries the actions that move a ticket along, so this screen
 * exists for what a list cannot show: the full description, the conversation,
 * and the files attached to it. Those were all reachable over HTTP and from
 * nowhere in the interface.
 *
 * Internal notes are marked rather than hidden from staff, and the server
 * withholds them from a resident entirely — the badge says which is which, so
 * an officer writing one can see who will read it.
 */
interface ServiceRequest {
  id: string;
  ticketNumber: string;
  category: string;
  priority: string;
  subject: string;
  description: string;
  status: string;
  location: string | null;
  attachmentIds: string[];
  assignedDepartment: string | null;
  assignedAt: string | null;
  dueAt: string;
  overdue: boolean;
  escalatedAt: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  satisfactionRating: number | null;
  createdAt: string;
}

interface Comment {
  id: string;
  body: string;
  internal: boolean;
  authorMembershipId: string | null;
  createdAt: string;
}

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

export default function ServiceRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [request, setRequest] = useState<ServiceRequest | null>(null);
  const [failed, setFailed] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsFailed, setCommentsFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequest(await api.get<ServiceRequest>(`/service-requests/${id}`));
      setFailed(false);
    } catch {
      // A ticket belonging to another household answers 404 here, exactly as a
      // ticket that does not exist does. There is nothing to distinguish.
      setFailed(true);
    }
  }, [id]);

  const loadComments = useCallback(async () => {
    try {
      setComments(await api.get<Comment[]>(`/service-requests/${id}/comments`));
      setCommentsFailed(false);
    } catch {
      setCommentsFailed(true);
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
          title="Ticket not found"
          description="It may have been closed, or it belongs to another household."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <BackLink />

      {request === null ? (
        <SkeletonTable rows={6} columns={2} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground font-mono text-xs">
                  {request.ticketNumber}
                </span>
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
                  {request.overdue ? 'overdue' : `due ${formatDateTime(request.dueAt)}`}
                </span>
              </div>

              <CardTitle className="text-balance">{request.subject}</CardTitle>
            </CardHeader>

            <CardContent className="space-y-4">
              <p className="text-sm whitespace-pre-wrap">{request.description}</p>

              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <Field label="Category">{request.category}</Field>
                <Field label="Raised">{formatDateTime(request.createdAt)}</Field>
                {request.location && (
                  <Field label="Location">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="size-3.5" aria-hidden />
                      {request.location}
                    </span>
                  </Field>
                )}
                {request.assignedDepartment && (
                  <Field label="Assigned to">{request.assignedDepartment}</Field>
                )}
                {request.assignedAt && (
                  <Field label="Assigned">{formatDateTime(request.assignedAt)}</Field>
                )}
                {request.satisfactionRating !== null && (
                  <Field label="Rated">{request.satisfactionRating} of 5</Field>
                )}
              </dl>

              {request.resolution && (
                <Alert tone="success" title="Resolution">
                  {request.resolution}
                  {request.resolvedAt && (
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {formatDateTime(request.resolvedAt)}
                    </span>
                  )}
                </Alert>
              )}
            </CardContent>
          </Card>

          <Attachments subjectType="service-request" subjectId={request.id} />

          <Thread
            comments={comments}
            failed={commentsFailed}
            closed={Boolean(request.closedAt)}
            onRetry={() => void loadComments()}
            onPost={async (body, internal) => {
              await api.post(`/service-requests/${request.id}/comments`, { body, internal });
              await loadComments();
            }}
          />
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/requests"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All requests
    </Link>
  );
}

function Thread({
  comments,
  failed,
  closed,
  onRetry,
  onPost,
}: {
  comments: Comment[] | null;
  failed: boolean;
  closed: boolean;
  onRetry: () => void;
  onPost: (body: string, internal: boolean) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;

    setBusy(true);
    setProblem(null);

    try {
      await onPost(body.trim(), internal);
      setBody('');
      setInternal(false);
    } catch {
      setProblem('That comment could not be posted.');
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
        {failed ? (
          <ErrorState onRetry={onRetry} />
        ) : comments === null ? (
          <SkeletonTable rows={2} columns={1} />
        ) : comments.length === 0 ? (
          <EmptyState title="Nothing said yet" description="Comments on this ticket appear here." />
        ) : (
          <ul aria-label="Comments" className="space-y-3">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className={
                  comment.internal ? 'bg-warning-muted rounded-lg p-3' : 'bg-muted rounded-lg p-3'
                }
              >
                <div className="mb-1 flex items-center gap-2">
                  {comment.internal && (
                    <Badge tone="warning" size="sm">
                      <EyeOff className="size-3" aria-hidden />
                      internal — not shown to the resident
                    </Badge>
                  )}
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                    {formatDateTime(comment.createdAt)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}

        {/* A closed ticket takes no further comment: the server refuses it, and
            offering the box anyway would only produce a rejection. */}
        {!closed && (
          <form onSubmit={submit} className="space-y-2 border-t pt-3">
            {problem && <Alert tone="danger">{problem}</Alert>}

            <Input
              label="Add a comment"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What has happened, or what is needed next"
              maxLength={5000}
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-muted-foreground flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(event) => setInternal(event.target.checked)}
                  className="accent-primary size-4"
                />
                Internal note — staff only
              </label>

              <Button type="submit" size="sm" disabled={busy || !body.trim()}>
                {busy ? 'Posting…' : 'Post'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
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
