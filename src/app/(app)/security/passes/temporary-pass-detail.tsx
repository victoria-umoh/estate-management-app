'use client';

import { useEffect, useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 * One temporary pass in full, and the means to withdraw it.
 *
 * Revoking is offered only to someone holding `temporaryPass.revoke` — a gate
 * officer can verify and record passages but not cancel a contractor's access;
 * that is a supervisor's call. The reason is required by the API and stated to
 * the sponsor, and the step is confirmed in place: the first press asks, the
 * second does it, with the consequence written between them.
 */
interface TemporaryPassDetail {
  id: string;
  code: string;
  holderName: string;
  holderPhone: string | null;
  company: string | null;
  purpose: string;
  vehiclePlate: string | null;
  status: 'active' | 'expired' | 'revoked';
  validFrom: string;
  validUntil: string;
  useCount: number;
  inside: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  notes: string | null;
  createdAt: string;
}

const STATUS_TONE = { active: 'success', expired: 'neutral', revoked: 'danger' } as const;

export function TemporaryPassDetailDialog({
  passId,
  canRevoke,
  onClose,
  onRevoked,
}: {
  passId: string;
  canRevoke: boolean;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [pass, setPass] = useState<TemporaryPassDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .get<TemporaryPassDetail>(`/temporary-passes/${passId}`)
      .then((result) => {
        if (!cancelled) setPass(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoadError(
            caught instanceof ApiRequestError ? caught.message : 'Could not load the pass.',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [passId]);

  async function revoke() {
    if (!pass) return;

    setRevoking(true);
    setError(null);
    try {
      const result = await api.post<{ status: string; revokedAt: string }>(
        `/temporary-passes/${pass.id}/revoke`,
        { reason: reason.trim() },
      );
      setPass({
        ...pass,
        status: 'revoked',
        revokedAt: result.revokedAt,
        revokedReason: reason.trim(),
      });
      setConfirming(false);
      toast.success(`Pass ${pass.code} revoked. The code no longer opens the gate.`);
      onRevoked();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not revoke the pass.');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pass ? pass.holderName : 'Temporary pass'}</DialogTitle>
          <DialogDescription>
            {pass ? (
              <>
                Code <span className="font-mono font-semibold">{pass.code}</span> · reusable within
                its window
              </>
            ) : (
              'Loading the pass…'
            )}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <Alert tone="danger">{loadError}</Alert>
        ) : !pass ? (
          <SkeletonText lines={5} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[pass.status]} dot>
                {pass.status}
              </Badge>
              {pass.status === 'active' && (
                <Badge tone={pass.inside ? 'info' : 'neutral'} size="sm" dot>
                  {pass.inside ? 'inside now' : 'outside'}
                </Badge>
              )}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Purpose</dt>
              <dd>{pass.purpose}</dd>
              {pass.company && (
                <>
                  <dt className="text-muted-foreground">Company</dt>
                  <dd>{pass.company}</dd>
                </>
              )}
              {pass.holderPhone && (
                <>
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd>
                    <a
                      href={`tel:${pass.holderPhone}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {pass.holderPhone}
                    </a>
                  </dd>
                </>
              )}
              {pass.vehiclePlate && (
                <>
                  <dt className="text-muted-foreground">Vehicle</dt>
                  <dd className="font-mono">{pass.vehiclePlate}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Valid</dt>
              <dd className="tabular-nums">
                {formatWhen(pass.validFrom)} – {formatWhen(pass.validUntil)}
              </dd>
              <dt className="text-muted-foreground">Passages</dt>
              <dd className="tabular-nums">
                {pass.useCount}
                {pass.lastUsedAt && ` · last ${formatWhen(pass.lastUsedAt)}`}
              </dd>
              {pass.notes && (
                <>
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd>{pass.notes}</dd>
                </>
              )}
            </dl>

            {pass.status === 'revoked' && (
              <Alert tone="warning" title="Revoked">
                {pass.revokedAt && `${formatWhen(pass.revokedAt)}. `}
                {pass.revokedReason}
              </Alert>
            )}

            {canRevoke && pass.status === 'active' && (
              <div className="border-border space-y-3 border-t pt-4">
                <Input
                  label="Reason for revoking"
                  value={reason}
                  maxLength={500}
                  placeholder="Contract ended early"
                  hint="The sponsoring resident is told this"
                  onChange={(event) => {
                    setReason(event.target.value);
                    setConfirming(false);
                  }}
                />

                {confirming && (
                  <Alert tone="danger" title={`Revoke ${pass.code}?`}>
                    The code stops opening the gate immediately, for every future visit.
                    {pass.inside &&
                      ' The holder is recorded as inside, and their exit can no longer be logged against this pass.'}{' '}
                    This cannot be undone; access again means a new pass.
                  </Alert>
                )}

                {error && <Alert tone="danger">{error}</Alert>}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={confirming ? () => setConfirming(false) : onClose}>
            {confirming ? 'Keep pass' : 'Close'}
          </Button>
          {canRevoke && pass?.status === 'active' && (
            <Button
              variant="danger"
              disabled={reason.trim().length < 2}
              loading={revoking}
              onClick={confirming ? () => void revoke() : () => setConfirming(true)}
            >
              <ShieldOff aria-hidden />
              {confirming ? 'Yes, revoke pass' : 'Revoke pass'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
