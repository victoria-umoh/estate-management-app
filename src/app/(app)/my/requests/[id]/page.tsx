'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, Clock, MapPin, MessageSquare, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Attachments } from '@/components/feature/attachments';
import { ApiRequestError, api } from '@/lib/api/client';
import { useProfile } from '@/lib/hooks/use-profile';

/**
 * One of the resident's own tickets.
 *
 * The server answers a neighbour's ticket with the same 404 as a missing one,
 * and withholds internal staff notes from the thread entirely, so nothing here
 * filters — it renders what it is given.
 *
 * Closing is the resident's call, not staff's: "resolved" means someone says it
 * is fixed, "closed" means the person who asked agrees. The rating is offered
 * only at that moment because the service accepts it only from the requester
 * and only on close.
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
  assignedDepartment: string | null;
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
  authorMembershipId: string;
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

export default function MyRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { profile } = useProfile();

  const [request, setRequest] = useState<ServiceRequest | null>(null);
  const [failed, setFailed] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsFailed, setCommentsFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequest(await api.get<ServiceRequest>(`/service-requests/${id}`));
      setFailed(false);
    } catch {
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
          title="Request not found"
          description="It may have been removed, or the link is wrong."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  const closed = request?.status === 'closed';

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
                <Badge tone={STATUS_TONE[request.status] ?? 'neutral'} size="sm" dot>
                  {request.status === 'awaiting-resident' ? 'waiting on you' : request.status}
                </Badge>
                <Badge tone={PRIORITY_TONE[request.priority] ?? 'neutral'} size="sm">
                  {request.priority}
                </Badge>
              </div>
              <CardTitle className="text-balance">{request.subject}</CardTitle>
            </CardHeader>

            <CardContent className="space-y-4">
              {request.status === 'awaiting-resident' && (
                <Alert tone="warning" title="The estate office needs something from you">
                  Read the latest message below and reply in the conversation.
                </Alert>
              )}

              <p className="text-sm whitespace-pre-wrap">{request.description}</p>

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                <Field label="Category">{request.category}</Field>
                <Field label="Raised">{formatDateTime(request.createdAt)}</Field>
                {!['resolved', 'closed'].includes(request.status) && (
                  <Field label="Response target">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3.5" aria-hidden />
                      {request.overdue ? 'past target' : formatDateTime(request.dueAt)}
                    </span>
                  </Field>
                )}
                {request.assignedDepartment && (
                  <Field label="With">{request.assignedDepartment}</Field>
                )}
                {request.location && (
                  <Field label="Location">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="size-3.5" aria-hidden />
                      {request.location}
                    </span>
                  </Field>
                )}
                {request.satisfactionRating !== null && (
                  <Field label="Your rating">{request.satisfactionRating} of 5</Field>
                )}
              </dl>

              {request.resolution && (
                <Alert tone="success" title="Marked as fixed">
                  {request.resolution}
                  {request.resolvedAt && (
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {formatDateTime(request.resolvedAt)}
                    </span>
                  )}
                </Alert>
              )}

              {!closed && (
                <CloseDialog
                  request={request}
                  onClosed={(updated) =>
                    setRequest((current) => current && { ...current, ...updated })
                  }
                />
              )}
            </CardContent>
          </Card>

          {/* A closed ticket still shows its files but takes no more. */}
          <Attachments subjectType="service-request" subjectId={request.id} canUpload={!closed} />

          <Thread
            comments={comments}
            failed={commentsFailed}
            closed={closed}
            me={profile?.membershipId ?? null}
            onRetry={() => void loadComments()}
            onPost={async (body) => {
              await api.post(`/service-requests/${request.id}/comments`, { body });
              await loadComments();
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Close the ticket, optionally rating the work.
 *
 * Worded differently depending on whether staff have marked it resolved: after
 * a resolution this is confirming the fix, before one it is withdrawing the
 * request — and the resident should know which they are doing.
 */
function CloseDialog({
  request,
  onClosed,
}: {
  request: ServiceRequest;
  onClosed: (updated: Partial<ServiceRequest>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One key per opening of the dialog, so pressing "Close ticket" again after
  // a dropped response replays the first close instead of failing with
  // "already closed".
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const resolved = request.status === 'resolved';

  async function close() {
    setBusy(true);
    setProblem(null);

    try {
      const query = rating ? `?satisfactionRating=${rating}` : '';
      const updated = await api.delete<{
        status: string;
        closedAt: string;
        satisfactionRating: number | null;
      }>(`/service-requests/${request.id}${query}`, { idempotencyKey });

      toast.success(`Ticket ${request.ticketNumber} closed`);
      setOpen(false);
      onClosed(updated);
    } catch (error) {
      setProblem(
        error instanceof ApiRequestError && error.status < 500
          ? error.message
          : 'Could not close the ticket. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setIdempotencyKey(crypto.randomUUID());
          setProblem(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={resolved ? 'primary' : 'outline'} block>
          <CheckCircle2 aria-hidden />
          {resolved ? 'Confirm it is fixed' : 'Close this request'}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{resolved ? 'Is it fixed?' : 'Close this request?'}</DialogTitle>
          <DialogDescription>
            {resolved
              ? 'Closing confirms the work is done. The ticket cannot be reopened — if the problem comes back, raise a new request.'
              : 'Closing withdraws the request before it has been resolved. It cannot be reopened.'}
          </DialogDescription>
        </DialogHeader>

        {problem && <Alert tone="danger">{problem}</Alert>}

        <fieldset>
          <legend className="text-foreground mb-2 text-sm font-medium">
            How was it handled? <span className="text-muted-foreground font-normal">Optional</span>
          </legend>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={rating === value}
                aria-label={`${value} of 5`}
                onClick={() => setRating((current) => (current === value ? null : value))}
                className="focus-visible:ring-ring grid size-11 place-items-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
              >
                <Star
                  className={
                    rating !== null && value <= rating
                      ? 'fill-warning text-warning size-6'
                      : 'text-muted-foreground size-6'
                  }
                  aria-hidden
                />
              </button>
            ))}
          </div>
        </fieldset>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Keep it open
          </Button>
          <Button onClick={() => void close()} loading={busy}>
            Close ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Thread({
  comments,
  failed,
  closed,
  me,
  onRetry,
  onPost,
}: {
  comments: Comment[] | null;
  failed: boolean;
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
        {failed ? (
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

        {/* The server refuses comments on a closed ticket, so none is offered. */}
        {!closed && (
          <form onSubmit={submit} className="space-y-2 border-t pt-3">
            {problem && <Alert tone="danger">{problem}</Alert>}

            <label className="block space-y-1.5">
              <span className="text-foreground block text-sm font-medium">Add a message</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={3}
                maxLength={5000}
                placeholder="Answer a question, or add anything that has changed"
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
      href="/my/requests"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
    >
      <ArrowLeft className="size-4" aria-hidden />
      My requests
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
