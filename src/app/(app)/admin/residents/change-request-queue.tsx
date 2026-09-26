'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, FilePen } from 'lucide-react';
import Link from 'next/link';
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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonText } from '@/components/ui/skeleton';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * Pending changes to load-bearing resident details.
 *
 * Both values arrive masked from the API and are shown exactly as given: the
 * reviewer judges whether the change is plausible, not the digits, and a queue
 * is read over shoulders like any other list. There is no reveal here.
 *
 * Renders nothing when the viewer cannot review (403) or the queue is empty, so
 * the directory is not topped by a card with nothing to do in it.
 */
interface ChangeRequest {
  id: string;
  membershipId: string;
  field: 'nin' | 'phone' | 'email' | 'propertyId' | 'category' | 'name';
  currentValue: string | null;
  requestedValue: string | null;
  reason?: string;
  requestedBy: string;
  createdAt: string;
}

const FIELD_LABEL: Record<ChangeRequest['field'], string> = {
  nin: 'NIN',
  phone: 'Phone',
  email: 'Email',
  propertyId: 'Unit',
  category: 'Category',
  name: 'Name',
};

/** What approval does beyond the change itself, stated before anyone commits to it. */
const APPROVAL_EFFECT: Partial<Record<ChangeRequest['field'], string>> = {
  nin: 'The new NIN is stored unverified and will need verifying again.',
  phone: 'The new number is stored unverified.',
  email: 'The new address is stored unverified.',
  propertyId: 'The resident is moved to the requested unit.',
};

const PAGE_SIZE = 25;

export function ChangeRequestQueue({ onReviewed }: { onReviewed?: () => void }) {
  const [requests, setRequests] = useState<ChangeRequest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reviewing, setReviewing] = useState<{ request: ChangeRequest; approve: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const page = await api.getPage<ChangeRequest>(`/change-requests?limit=${PAGE_SIZE}`);
      setRequests(page.items);
      setTotal(page.meta.total);
      setFailed(false);
    } catch (error) {
      // Reviewing is its own permission. Someone who can browse the directory
      // but not approve changes simply does not see the queue.
      if (error instanceof ApiRequestError && error.status === 403) setHidden(true);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;
  if (requests !== null && requests.length === 0 && !failed) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FilePen className="text-muted-foreground size-4" aria-hidden />
          Change requests
          {total > 0 && (
            <Badge tone="warning" size="sm">
              {total}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {failed ? (
          <Alert tone="danger" title="Could not load change requests">
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void load()}>
              Try again
            </Button>
          </Alert>
        ) : requests === null ? (
          <SkeletonText lines={3} />
        ) : (
          <>
            <ul className="divide-border divide-y">
              {requests.map((request) => (
                <li key={request.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral" size="sm">
                      {FIELD_LABEL[request.field]}
                    </Badge>
                    <Link
                      href={`/admin/residents/${request.membershipId}`}
                      className="text-primary text-sm underline-offset-4 hover:underline"
                    >
                      View resident
                    </Link>
                    <span className="text-muted-foreground ml-auto text-xs">
                      {new Date(request.createdAt).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  </div>

                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground font-mono break-all">
                      {request.currentValue ?? 'Not shown'}
                    </span>
                    <ArrowRight className="text-muted-foreground size-4 shrink-0" aria-label="to" />
                    <span className="font-mono font-medium break-all">
                      {request.requestedValue ?? 'Not shown'}
                    </span>
                  </p>

                  {request.reason && (
                    <p className="text-muted-foreground text-sm text-pretty">
                      &ldquo;{request.reason}&rdquo;
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setReviewing({ request, approve: true })}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReviewing({ request, approve: false })}
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            {total > requests.length && (
              <p className="text-muted-foreground mt-3 text-xs">
                Showing the oldest {requests.length} of {total}. Newer requests appear as these are
                cleared.
              </p>
            )}
          </>
        )}
      </CardContent>

      {/* Keyed so one request's note is never carried into the next. */}
      <ReviewDialog
        key={reviewing ? `${reviewing.request.id}:${reviewing.approve}` : 'closed'}
        review={reviewing}
        onClose={() => setReviewing(null)}
        onDone={() => {
          setReviewing(null);
          void load();
          onReviewed?.();
        }}
      />
    </Card>
  );
}

function ReviewDialog({
  review,
  onClose,
  onDone,
}: {
  review: { request: ChangeRequest; approve: boolean } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!review) return null;
  const { request, approve } = review;
  const field = FIELD_LABEL[request.field].toLowerCase();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/change-requests/${request.id}`, {
        approve,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(approve ? `${FIELD_LABEL[request.field]} change applied` : 'Request rejected');
      onDone();
    } catch (caught) {
      // The API's own words matter here: it names an identity clash, a request
      // already decided, or a reviewer trying to approve their own submission.
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not record the decision.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {approve ? `Approve ${field} change?` : `Reject ${field} change?`}
          </DialogTitle>
          <DialogDescription>
            {approve
              ? `The resident's ${field} is changed now, in the same step as this approval. ${
                  APPROVAL_EFFECT[request.field] ?? ''
                }`
              : 'Nothing on the resident’s record changes. The decision and any note are recorded.'}
          </DialogDescription>
        </DialogHeader>

        <Input
          label="Note (optional)"
          hint="Kept with the decision in the audit trail."
          value={note}
          maxLength={1000}
          autoComplete="off"
          onChange={(event) => setNote(event.target.value)}
        />

        {error && (
          <Alert tone="danger" className="mt-3">
            {error}
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={approve ? 'primary' : 'danger'}
            loading={busy}
            onClick={() => void submit()}
          >
            {approve ? 'Approve and apply' : 'Reject'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
