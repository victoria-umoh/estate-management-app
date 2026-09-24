'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, History } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';

/**
 * One tenancy, with its full lease history.
 *
 * The register could only say "renewed 2×". This is where those two renewals
 * are actually legible, because the question they answer — who was entitled to
 * be here, and between which dates — is asked months later, usually in a
 * dispute, and a count does not answer it.
 *
 * Ending a tenancy is the one destructive-looking action here, and it is not
 * destructive: the row stays, because gate logs and invoices from that period
 * point back at it. The confirm says so, since "end" reads like "delete" to
 * someone about to press it.
 */
interface LeaseTerm {
  leaseStartDate: string | null;
  leaseEndDate: string | null;
  supersededAt: string;
}

interface Tenancy {
  id: string;
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
  previousLeaseTerms: LeaseTerm[];
}

const END_REASONS = ['lease-ended', 'moved-out', 'evicted', 'corrected'] as const;

export default function TenancyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [tenancy, setTenancy] = useState<Tenancy | null>(null);
  const [failed, setFailed] = useState(false);
  const [endReason, setEndReason] = useState<string>('lease-ended');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTenancy(await api.get<Tenancy>(`/tenancies/${id}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function end() {
    setBusy(true);
    try {
      await api.delete(`/tenancies/${id}?endReason=${endReason}`);
      toast.success('Tenancy ended. The record is kept.');
      await load();
    } catch {
      toast.error('Could not end that tenancy.');
    } finally {
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState
          title="Tenancy not found"
          description="It may belong to another estate, or the id is wrong."
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <BackLink />

      {tenancy === null ? (
        <SkeletonTable rows={5} columns={2} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{tenancy.occupantName ?? 'Occupant record missing'}</CardTitle>
                <StatusBadge tenancy={tenancy} />
              </div>
              <p className="text-muted-foreground text-sm">
                {tenancy.unitNumber ? `Unit ${tenancy.unitNumber}` : 'Unit unknown'}
                {tenancy.street ? ` · ${tenancy.street}` : ''}
              </p>
            </CardHeader>

            <CardContent className="space-y-4">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <Field label="Current term">
                  {formatDate(tenancy.leaseStartDate)} → {formatDate(tenancy.leaseEndDate)}
                </Field>
                <Field label="Occupancy began">{formatDate(tenancy.startedAt)}</Field>
                {tenancy.occupantCount && <Field label="Occupants">{tenancy.occupantCount}</Field>}
                <Field label="Approved">
                  {tenancy.approvedAt ? formatDate(tenancy.approvedAt) : 'Not yet approved'}
                </Field>
                {tenancy.endedAt && (
                  <>
                    <Field label="Ended">{formatDate(tenancy.endedAt)}</Field>
                    <Field label="Reason">{tenancy.endReason ?? 'not recorded'}</Field>
                  </>
                )}
              </dl>

              {!tenancy.endedAt && (
                <div className="space-y-2 border-t pt-3">
                  {/* The reason is chosen before confirming rather than inside
                      the dialog: it is a decision about the record, not a
                      safety check, and it belongs with the record. */}
                  <span className="text-muted-foreground text-xs font-medium">
                    Reason for ending
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {END_REASONS.map((reason) => (
                      <button
                        key={reason}
                        type="button"
                        aria-pressed={endReason === reason}
                        onClick={() => setEndReason(reason)}
                        className={
                          endReason === reason
                            ? 'border-primary bg-primary-muted text-primary rounded-full border px-2.5 py-1 text-xs font-medium'
                            : 'border-input text-muted-foreground hover:bg-accent rounded-full border px-2.5 py-1 text-xs'
                        }
                      >
                        {reason.replace(/-/g, ' ')}
                      </button>
                    ))}

                    <div className="ml-auto">
                      <ConfirmDialog
                        trigger={
                          <Button variant="outline" size="sm" disabled={busy}>
                            End tenancy
                          </Button>
                        }
                        title="End this tenancy?"
                        description="The record is kept, not deleted — gate logs and invoices from this period point back at it."
                        confirmLabel="End tenancy"
                        onConfirm={end}
                      />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4" aria-hidden />
                Lease history
                {tenancy.previousLeaseTerms.length > 0 && (
                  <Badge tone="neutral" size="sm">
                    {tenancy.previousLeaseTerms.length} superseded
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>

            <CardContent>
              {tenancy.previousLeaseTerms.length === 0 ? (
                <EmptyState
                  title="Never renewed"
                  description="The original lease term is still the current one."
                />
              ) : (
                // Newest first: the most recent supersession is the one being
                // asked about most often.
                <ul aria-label="Superseded lease terms" className="divide-border divide-y">
                  {[...tenancy.previousLeaseTerms]
                    .sort(
                      (a, b) =>
                        new Date(b.supersededAt).getTime() - new Date(a.supersededAt).getTime(),
                    )
                    .map((term) => (
                      <li
                        key={term.supersededAt}
                        className="flex flex-wrap items-center gap-2 py-2.5 text-sm"
                      >
                        <span className="tabular-nums">
                          {formatDate(term.leaseStartDate)} → {formatDate(term.leaseEndDate)}
                        </span>
                        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                          replaced {formatDate(term.supersededAt)}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/tenancies"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
    >
      <ArrowLeft className="size-4" aria-hidden />
      All tenancies
    </Link>
  );
}

function StatusBadge({ tenancy }: { tenancy: Tenancy }) {
  if (tenancy.endedAt) {
    return (
      <Badge tone="neutral" size="sm">
        ended
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

  const expired = tenancy.leaseEndDate && new Date(tenancy.leaseEndDate) < new Date();

  return (
    <Badge tone={expired ? 'danger' : 'success'} size="sm" dot>
      {expired ? 'lease expired' : 'active'}
    </Badge>
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

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
