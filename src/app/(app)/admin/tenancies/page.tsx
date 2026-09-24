'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The tenancy register.
 *
 * Ordered around the decision the screen exists for: a tenancy someone typed in
 * is not one the estate stands behind until it is approved, so "pending" is the
 * default view rather than "all". An administrator opening this page is almost
 * always here to sign something off or to extend it.
 *
 * Approval and renewal are the two writes. Both are irreversible in the sense
 * that matters — an approval is stamped with who gave it, and a renewal
 * supersedes the outgoing lease window — so each confirms first and says what
 * it is about to do in the units a person thinks in.
 */
interface Tenancy {
  id: string;
  propertyId: string;
  membershipId: string;
  unitNumber: string | null;
  street: string | null;
  occupantName: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  approvedAt: string | null;
  leaseStartDate: string | null;
  leaseEndDate: string | null;
  occupantCount: number | null;
  previousLeaseTerms: Array<{
    leaseStartDate: string | null;
    leaseEndDate: string | null;
    supersededAt: string;
  }>;
}

const STATES = ['pending', 'approved', 'active', 'ended'] as const;
const PAGE_SIZE = 25;

export default function TenanciesPage() {
  const [tenancies, setTenancies] = useState<Tenancy[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Pending first: the register is opened to sign something off far more often
  // than to browse the estate's whole letting history.
  const [state, setState] = useState<string>('pending');
  const [page, setPage] = useState(1);
  const [renewing, setRenewing] = useState<Tenancy | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (state) params.set('state', state);
    return params.toString();
  }, [page, state]);

  const load = useCallback(async () => {
    try {
      setTenancies(await api.get<Tenancy[]>(`/tenancies?${query}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(tenancy: Tenancy) {
    setBusyId(tenancy.id);
    try {
      await api.post(`/tenancies/${tenancy.id}/approve`, {});
      toast.success(`Tenancy approved for ${describe(tenancy)}`);
      await load();
    } catch {
      toast.error('Could not approve that tenancy.');
    } finally {
      setBusyId(null);
    }
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Tenancies</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Register</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground mr-1 text-xs font-medium">Status</span>
            {['', ...STATES].map((option) => (
              <button
                key={option || 'all'}
                type="button"
                aria-pressed={state === option}
                onClick={() => {
                  setState(option);
                  setPage(1);
                }}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  state === option
                    ? 'border-primary bg-primary-muted text-primary font-medium'
                    : 'border-input text-muted-foreground hover:bg-accent',
                )}
              >
                {option || 'All'}
              </button>
            ))}
          </div>

          {tenancies === null ? (
            <SkeletonTable rows={6} columns={4} />
          ) : tenancies.length === 0 ? (
            <EmptyState
              variant={state ? 'no-results' : 'empty'}
              title={state === 'pending' ? 'Nothing waiting for approval' : 'No tenancies here'}
              description={
                state === 'pending'
                  ? 'Recorded tenancies appear here until someone signs them off.'
                  : 'Tenancies appear here once a tenant is assigned to a unit.'
              }
            />
          ) : (
            <ul aria-label="Tenancies" className="divide-border divide-y">
              {tenancies.map((tenancy) => (
                <li key={tenancy.id} className="flex flex-wrap items-center gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {tenancy.occupantName ?? 'Occupant record missing'}
                    </p>
                    <p className="text-muted-foreground truncate text-sm">
                      {tenancy.unitNumber ? `Unit ${tenancy.unitNumber}` : 'Unit unknown'}
                      {tenancy.street ? ` · ${tenancy.street}` : ''}
                      {tenancy.occupantCount ? ` · ${tenancy.occupantCount} occupants` : ''}
                    </p>
                  </div>

                  <div className="text-muted-foreground text-xs tabular-nums">
                    {formatTerm(tenancy)}
                  </div>

                  <StatusBadge tenancy={tenancy} />

                  {/* Renewals are counted, because "how many times has this been
                      extended" is the question a chairman asks before agreeing
                      to extend it again. */}
                  {tenancy.previousLeaseTerms.length > 0 && (
                    <Badge tone="neutral" size="sm">
                      renewed {tenancy.previousLeaseTerms.length}×
                    </Badge>
                  )}

                  {!tenancy.endedAt && (
                    <div className="flex gap-1.5">
                      {!tenancy.approvedAt && (
                        <Button
                          size="sm"
                          disabled={busyId === tenancy.id}
                          onClick={() => void approve(tenancy)}
                        >
                          Approve
                        </Button>
                      )}
                      {tenancy.approvedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === tenancy.id}
                          onClick={() => setRenewing(tenancy)}
                        >
                          Renew
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={tenancies === null || tenancies.length < PAGE_SIZE}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </CardContent>
      </Card>

      <RenewDialog
        tenancy={renewing}
        onClose={() => setRenewing(null)}
        onRenewed={async () => {
          setRenewing(null);
          await load();
        }}
      />
    </div>
  );
}

function StatusBadge({ tenancy }: { tenancy: Tenancy }) {
  if (tenancy.endedAt) {
    return (
      <Badge tone="neutral" size="sm">
        ended{tenancy.endReason ? ` · ${tenancy.endReason}` : ''}
      </Badge>
    );
  }

  if (!tenancy.approvedAt) {
    return (
      <Badge tone="warning" size="sm" dot>
        pending approval
      </Badge>
    );
  }

  // An approved tenancy whose lease has run out is still the estate's problem,
  // so it reads as expired rather than quietly as active.
  const expired = tenancy.leaseEndDate && new Date(tenancy.leaseEndDate) < new Date();

  return (
    <Badge tone={expired ? 'danger' : 'success'} size="sm" dot>
      {expired ? 'lease expired' : 'active'}
    </Badge>
  );
}

function RenewDialog({
  tenancy,
  onClose,
  onRenewed,
}: {
  tenancy: Tenancy | null;
  onClose: () => void;
  onRenewed: () => Promise<void>;
}) {
  const [leaseEndDate, setLeaseEndDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLeaseEndDate('');
    setProblem(null);
  }, [tenancy?.id]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!tenancy) return;

    setBusy(true);
    setProblem(null);

    try {
      await api.post(`/tenancies/${tenancy.id}/renew`, {
        leaseEndDate: new Date(leaseEndDate).toISOString(),
      });
      toast.success(`Tenancy renewed for ${describe(tenancy)}`);
      await onRenewed();
    } catch {
      // The server refuses a date that does not extend the term, and says so.
      // Repeating its reasoning here would let the two drift apart.
      setProblem('Could not renew that tenancy. The new end date must extend the current term.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(tenancy)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renew tenancy</DialogTitle>
          <DialogDescription>
            The outgoing lease window is kept on the record, so who was entitled to be here, and
            when, stays answerable.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          {tenancy && (
            <p className="text-muted-foreground text-sm">
              {describe(tenancy)} — current term ends{' '}
              {tenancy.leaseEndDate ? formatDate(tenancy.leaseEndDate) : 'on no recorded date'}.
            </p>
          )}

          <Input
            type="date"
            label="New lease end date"
            value={leaseEndDate}
            onChange={(event) => setLeaseEndDate(event.target.value)}
            required
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !leaseEndDate}>
              Renew
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function describe(tenancy: Tenancy): string {
  const who = tenancy.occupantName ?? 'this occupant';
  return tenancy.unitNumber ? `${who} at unit ${tenancy.unitNumber}` : who;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTerm(tenancy: Tenancy): string {
  if (!tenancy.leaseStartDate && !tenancy.leaseEndDate) return 'no lease dates';
  const from = tenancy.leaseStartDate ? formatDate(tenancy.leaseStartDate) : '—';
  const to = tenancy.leaseEndDate ? formatDate(tenancy.leaseEndDate) : '—';
  return `${from} → ${to}`;
}
