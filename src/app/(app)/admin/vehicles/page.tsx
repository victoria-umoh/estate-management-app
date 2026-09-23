'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ban, Car, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The vehicle register.
 *
 * Blacklisting is the only consequential thing on this page: it stops a car at
 * the gate, in front of whoever is driving it. So it is deliberately two steps
 * — a reason, then a typed plate — and a blacklisted row is marked by border,
 * fill, icon and text rather than by colour alone, because the officer reading
 * this may be doing so on a sunlit tablet.
 */
type VehicleStatus = 'pending' | 'active' | 'suspended' | 'blacklisted' | 'expired' | 'removed';

interface Vehicle {
  id: string;
  plateNumber: string;
  /** Colour, make and model, pre-joined by the API. */
  description: string;
  type: string;
  status: VehicleStatus;
  ownerMembershipId: string;
}

const STATUSES: VehicleStatus[] = [
  'pending',
  'active',
  'suspended',
  'blacklisted',
  'expired',
  'removed',
];

const STATUS_TONE: Record<VehicleStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'warning',
  active: 'success',
  suspended: 'warning',
  blacklisted: 'danger',
  expired: 'neutral',
  removed: 'neutral',
};

export default function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<VehicleStatus | 'all'>('all');
  // Blacklisting is modelled server-side as a status, not as a separate flag,
  // so this switch and the status filter are one underlying query. They are
  // kept mutually exclusive rather than pretending to be independent.
  const [blacklistedOnly, setBlacklistedOnly] = useState(false);

  const effectiveStatus: VehicleStatus | 'all' = blacklistedOnly ? 'blacklisted' : status;

  const load = useCallback(async () => {
    try {
      const query = effectiveStatus === 'all' ? '' : `&status=${effectiveStatus}`;
      setVehicles(await api.get<Vehicle[]>(`/vehicles?limit=100${query}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [effectiveStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Vehicles</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 pt-4">
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              label="All"
              active={status === 'all' && !blacklistedOnly}
              disabled={blacklistedOnly}
              onClick={() => setStatus('all')}
            />
            {STATUSES.map((value) => (
              <FilterChip
                key={value}
                label={value}
                active={!blacklistedOnly && status === value}
                disabled={blacklistedOnly}
                onClick={() => setStatus(value)}
              />
            ))}
          </div>

          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-danger size-4"
              checked={blacklistedOnly}
              onChange={(event) => setBlacklistedOnly(event.target.checked)}
            />
            <span className="text-foreground">Blacklisted only</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-2 pt-2 sm:p-4 sm:pt-4">
          {vehicles === null ? (
            <SkeletonTable rows={6} columns={4} />
          ) : vehicles.length === 0 ? (
            <EmptyState
              icon={<Car aria-hidden />}
              variant={effectiveStatus === 'all' ? 'empty' : 'no-results'}
              title={
                effectiveStatus === 'all' ? 'No vehicles registered' : 'No vehicles match that'
              }
              description={
                effectiveStatus === 'all'
                  ? 'Registered resident vehicles appear here.'
                  : 'Try a different status filter.'
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {vehicles.map((vehicle) => (
                <li
                  key={vehicle.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2.5',
                    vehicle.status === 'blacklisted' &&
                      'bg-danger-muted border-danger my-1 rounded-r-md border-l-4 px-3',
                  )}
                >
                  {vehicle.status === 'blacklisted' && (
                    <Ban className="text-danger size-4 shrink-0" aria-hidden />
                  )}

                  <span className="font-mono text-sm font-semibold tracking-wide tabular-nums">
                    {vehicle.plateNumber}
                  </span>

                  <span className="text-muted-foreground min-w-0 flex-1 basis-40 truncate text-sm">
                    {vehicle.description}
                    <span className="ml-1.5 text-xs">· {vehicle.type}</span>
                  </span>

                  <span className="text-muted-foreground font-mono text-[11px]">
                    owner {vehicle.ownerMembershipId.slice(-6)}
                  </span>

                  <Badge tone={STATUS_TONE[vehicle.status]} dot size="sm">
                    {vehicle.status === 'blacklisted' ? 'BLACKLISTED' : vehicle.status}
                  </Badge>

                  <BlacklistAction vehicle={vehicle} onDone={() => void load()} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FilterChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {label}
    </button>
  );
}

/**
 * Blacklist or reinstate one vehicle.
 *
 * The reason is captured first and the typed-plate confirmation second, because
 * the reason is the only part of this that survives into the audit record — and
 * asking for it after the confirmation would invite an empty string.
 */
function BlacklistAction({ vehicle, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const blacklisting = vehicle.status !== 'blacklisted';
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    try {
      await api.post<{ status: string }>(`/vehicles/${vehicle.id}/blacklist`, {
        blacklisted: blacklisting,
        reason: reason.trim(),
      });
      setOpen(false);
      setReason('');
      setError(null);
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not update this vehicle.');
    }
  }

  return (
    <>
      <Button size="sm" variant={blacklisting ? 'outline' : 'danger'} onClick={() => setOpen(true)}>
        {blacklisting ? <Ban aria-hidden /> : <ShieldCheck aria-hidden />}
        {blacklisting ? 'Blacklist' : 'Reinstate'}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setReason('');
            setError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {blacklisting ? 'Blacklist' : 'Reinstate'} {vehicle.plateNumber}
            </DialogTitle>
            <DialogDescription>
              {blacklisting
                ? 'This car will be turned away at every gate until it is reinstated. Say why, so the officer refusing entry can explain the decision.'
                : 'This car will be admitted again. Say why it is being reinstated.'}
            </DialogDescription>
          </DialogHeader>

          <Input
            label="Reason"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={blacklisting ? 'Unpaid levy, repeated gate abuse…' : 'Dispute resolved…'}
            maxLength={500}
            error={error ?? undefined}
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <ConfirmDialog
              trigger={
                <Button variant="danger" disabled={reason.trim().length === 0}>
                  {blacklisting ? 'Blacklist vehicle' : 'Reinstate vehicle'}
                </Button>
              }
              title={
                blacklisting
                  ? `Blacklist ${vehicle.plateNumber}?`
                  : `Reinstate ${vehicle.plateNumber}?`
              }
              description={
                blacklisting
                  ? `${vehicle.description} will be refused at the gate from the moment you confirm.`
                  : `${vehicle.description} will be admitted at the gate again from the moment you confirm.`
              }
              confirmPhrase={vehicle.plateNumber}
              confirmLabel={blacklisting ? 'Blacklist' : 'Reinstate'}
              tone="danger"
              onConfirm={submit}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
