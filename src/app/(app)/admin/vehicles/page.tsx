'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ban, Car, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ResidentPicker, type ResidentOption } from '../properties/_components/resident-picker';
import { VEHICLE_TYPES, type VehicleType } from './_components/vehicle-fields';

/**
 * The vehicle register.
 *
 * Blacklisting is the only consequential thing on this page: it stops a car at
 * the gate, in front of whoever is driving it. So it is deliberately two steps
 * — a reason, then a typed plate — and a blacklisted row is marked by border,
 * fill, icon and text rather than by colour alone, because the officer reading
 * this may be doing so on a sunlit tablet.
 *
 * Registration lands a car as pending; it only opens a gate once verified,
 * which happens on the vehicle's own page because that is where the one-time
 * credential can be shown and handed over.
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
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()}>
            Refresh
          </Button>
          <RegisterVehicleDialog />
        </div>
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

                  <Link
                    href={`/admin/vehicles/${vehicle.id}`}
                    className="text-primary font-mono text-sm font-semibold tracking-wide tabular-nums underline-offset-4 hover:underline"
                  >
                    {vehicle.plateNumber}
                  </Link>

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

/**
 * Put a resident's car on the register.
 *
 * The owner is picked by name, never typed as an id. Only the fields the API
 * requires are marked required; the optional ones are omitted rather than sent
 * empty, since the schema treats an empty string as a value and not an absence.
 */
function RegisterVehicleDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [owner, setOwner] = useState<ResidentOption | null>(null);
  const [plateNumber, setPlateNumber] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [colour, setColour] = useState('');
  const [year, setYear] = useState('');
  const [type, setType] = useState<VehicleType>('car');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [insuranceProvider, setInsuranceProvider] = useState('');
  const [insuranceExpiryDate, setInsuranceExpiryDate] = useState('');

  function reset() {
    setOwner(null);
    setPlateNumber('');
    setMake('');
    setModel('');
    setColour('');
    setYear('');
    setType('car');
    setDriverName('');
    setDriverPhone('');
    setInsuranceProvider('');
    setInsuranceExpiryDate('');
    setError(null);
  }

  const ready =
    owner !== null &&
    plateNumber.trim().length >= 3 &&
    make.trim().length > 0 &&
    model.trim().length > 0 &&
    colour.trim().length >= 2;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!owner) return;

    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/vehicles', {
        ownerMembershipId: owner.membershipId,
        plateNumber: plateNumber.trim(),
        make: make.trim(),
        model: model.trim(),
        colour: colour.trim(),
        type,
        ...(year ? { year: Number(year) } : {}),
        ...(driverName.trim() ? { driverName: driverName.trim() } : {}),
        ...(driverPhone.trim() ? { driverPhone: driverPhone.trim() } : {}),
        ...(insuranceProvider.trim() ? { insuranceProvider: insuranceProvider.trim() } : {}),
        ...(insuranceExpiryDate ? { insuranceExpiryDate } : {}),
      });
      setOpen(false);
      reset();
      router.push(`/admin/vehicles/${created.id}`);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The vehicle was not registered.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          Register vehicle
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a vehicle</DialogTitle>
          <DialogDescription>
            It is added as pending and will not open a gate until it is verified.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <ResidentPicker label="Owner" value={owner} onChange={setOwner} />

          <Input
            label="Plate number"
            required
            minLength={3}
            maxLength={20}
            value={plateNumber}
            onChange={(event) => setPlateNumber(event.target.value)}
            placeholder="ABC-123-XY"
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
          />

          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Make"
              required
              maxLength={40}
              value={make}
              onChange={(event) => setMake(event.target.value)}
              placeholder="Toyota"
            />
            <Input
              label="Model"
              required
              maxLength={40}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Corolla"
            />
            <Input
              label="Colour"
              required
              minLength={2}
              maxLength={30}
              value={colour}
              onChange={(event) => setColour(event.target.value)}
              placeholder="Silver"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-foreground block text-sm font-medium">Type</span>
              <select
                value={type}
                onChange={(event) => setType(event.target.value as VehicleType)}
                className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm capitalize focus-visible:ring-2 focus-visible:outline-none"
              >
                {VEHICLE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Year"
              type="number"
              min={1900}
              max={2100}
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </div>

          <details className="group rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Driver and insurance (optional)
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input
                label="Driver name"
                maxLength={80}
                value={driverName}
                onChange={(event) => setDriverName(event.target.value)}
              />
              <Input
                label="Driver phone"
                type="tel"
                maxLength={20}
                value={driverPhone}
                onChange={(event) => setDriverPhone(event.target.value)}
              />
              <Input
                label="Insurer"
                maxLength={80}
                value={insuranceProvider}
                onChange={(event) => setInsuranceProvider(event.target.value)}
              />
              <Input
                label="Insurance expires"
                type="date"
                value={insuranceExpiryDate}
                onChange={(event) => setInsuranceExpiryDate(event.target.value)}
              />
            </div>
          </details>

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!ready}>
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
