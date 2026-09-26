'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Ban, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';
import { CredentialReceipt } from '../_components/credential-receipt';
import { VEHICLE_TYPES, type VehicleType } from '../_components/vehicle-fields';

/**
 * One vehicle: what is on record, and the three things done to it here.
 *
 * Verification and a plate change both hand back a gate credential exactly
 * once. The receipt is held in this page's state and nowhere else, and it sits
 * above everything so it cannot be scrolled past and lost. Blacklisting stays
 * on the register, where it was designed as a two-step action; this page only
 * reports the reason.
 *
 * The owner's name and unit come from the resident record. A viewer without
 * resident access still gets the vehicle, with the owner shown by id.
 */
type VehicleStatus = 'pending' | 'active' | 'suspended' | 'blacklisted' | 'expired' | 'removed';

interface Vehicle {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  colour: string;
  year: number | null;
  type: VehicleType;
  status: VehicleStatus;
  ownerMembershipId: string;
  driverName: string | null;
  driverPhone: string | null;
  insuranceProvider: string | null;
  insuranceExpiryDate: string | null;
  verifiedAt: string | null;
  blacklistReason: string | null;
}

interface Owner {
  fullName: string;
  unitNumber: string | null;
  category: string;
}

interface Receipt {
  token: string;
  plateNumber: string;
  reason: string;
}

const STATUS_TONE: Record<VehicleStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'warning',
  active: 'success',
  suspended: 'warning',
  blacklisted: 'danger',
  expired: 'neutral',
  removed: 'neutral',
};

export default function VehicleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'denied' | 'failed'>(
    'loading',
  );
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const load = useCallback(async () => {
    if (!id) return;

    let result: Vehicle;
    try {
      result = await api.get<Vehicle>(`/vehicles/${id}`);
      setVehicle(result);
      setState('ready');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) setState('missing');
      else if (error instanceof ApiRequestError && error.status === 403) setState('denied');
      else setState('failed');
      return;
    }

    try {
      setOwner(await api.get<Owner>(`/residents/${result.ownerMembershipId}`));
    } catch {
      setOwner(null);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'failed') return <ErrorState onRetry={() => void load()} />;
  if (state === 'denied') return <PermissionDeniedState action="view this vehicle" />;

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" className="-ml-2" asChild>
        <Link href="/admin/vehicles">
          <ArrowLeft aria-hidden />
          Vehicles
        </Link>
      </Button>

      {state === 'missing' ? (
        <EmptyState
          variant="no-results"
          title="Vehicle not found"
          description="It may have been removed from the register."
          action={
            <Button variant="outline" asChild>
              <Link href="/admin/vehicles">Back to vehicles</Link>
            </Button>
          }
        />
      ) : vehicle === null ? (
        <>
          <Skeleton className="h-7 w-40" />
          <Card>
            <CardContent className="p-4 pt-4">
              <SkeletonText lines={5} />
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-xl font-semibold tracking-wide tabular-nums">
                {vehicle.plateNumber}
              </h1>
              <Badge tone={STATUS_TONE[vehicle.status]} dot>
                {vehicle.status === 'blacklisted' ? 'BLACKLISTED' : vehicle.status}
              </Badge>
              <Badge tone="neutral">{vehicle.type}</Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {vehicle.colour} {vehicle.make} {vehicle.model}
              {vehicle.year ? ` · ${vehicle.year}` : ''}
            </p>
          </div>

          {receipt && (
            <CredentialReceipt
              plateNumber={receipt.plateNumber}
              token={receipt.token}
              reason={receipt.reason}
              onDismiss={() => setReceipt(null)}
            />
          )}

          {vehicle.status === 'blacklisted' && (
            <Alert tone="danger" title="Blacklisted — refused at every gate">
              {vehicle.blacklistReason ?? 'No reason recorded.'} Reinstate it from the vehicle
              register.
            </Alert>
          )}

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>Details</CardTitle>
              <EditVehicleDialog
                vehicle={vehicle}
                onSaved={async (token, plateNumber) => {
                  if (token) {
                    setReceipt({
                      token,
                      plateNumber,
                      reason: `Credential reissued for ${plateNumber}`,
                    });
                  }
                  await load();
                }}
              />
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Owner">
                  {owner ? (
                    <Link
                      href={`/admin/residents/${vehicle.ownerMembershipId}`}
                      className="text-primary font-medium underline-offset-4 hover:underline"
                    >
                      {owner.fullName}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{vehicle.ownerMembershipId}</span>
                  )}
                  {owner?.unitNumber && (
                    <span className="text-muted-foreground text-xs"> · {owner.unitNumber}</span>
                  )}
                </Field>
                <Field label="Verified">
                  {vehicle.verifiedAt ? (
                    formatDate(vehicle.verifiedAt)
                  ) : (
                    <span className="text-muted-foreground">Not yet</span>
                  )}
                </Field>
                <Field label="Driver">
                  {vehicle.driverName || vehicle.driverPhone ? (
                    [vehicle.driverName, vehicle.driverPhone].filter(Boolean).join(' · ')
                  ) : (
                    <span className="text-muted-foreground">Owner drives</span>
                  )}
                </Field>
                <Field label="Insurer">
                  {vehicle.insuranceProvider ?? <span className="text-muted-foreground">—</span>}
                </Field>
                <Field label="Insurance expires">
                  {vehicle.insuranceExpiryDate ? (
                    <span
                      className={
                        new Date(vehicle.insuranceExpiryDate) < new Date()
                          ? 'text-danger font-medium'
                          : undefined
                      }
                    >
                      {formatDate(vehicle.insuranceExpiryDate)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Field>
              </dl>
            </CardContent>
          </Card>

          <VerifyCard
            vehicle={vehicle}
            defaultUnitNumber={owner?.unitNumber ?? ''}
            onVerified={async (token) => {
              setReceipt({
                token,
                plateNumber: vehicle.plateNumber,
                reason: `${vehicle.plateNumber} verified — gate credential issued`,
              });
              await load();
            }}
          />

          <RemoveCard vehicle={vehicle} onRemoved={() => router.push('/admin/vehicles')} />
        </>
      )}
    </div>
  );
}

/**
 * Verify the vehicle and issue its gate credential.
 *
 * Verifying an already-verified vehicle is allowed and is how a lost pass is
 * replaced: the new credential supersedes the old one, which stops working at
 * the gate immediately. The confirm step says which of the two is happening.
 */
function VerifyCard({
  vehicle,
  defaultUnitNumber,
  onVerified,
}: {
  vehicle: Vehicle;
  defaultUnitNumber: string;
  onVerified: (token: string) => Promise<void>;
}) {
  const [ownerLabel, setOwnerLabel] = useState('Resident');
  const [unitNumber, setUnitNumber] = useState(defaultUnitNumber);
  const [error, setError] = useState<string | null>(null);

  // The owner's unit arrives after the vehicle; fill it in if nobody has typed.
  useEffect(() => {
    setUnitNumber((current) => current || defaultUnitNumber);
  }, [defaultUnitNumber]);

  const reissue = vehicle.verifiedAt !== null;
  const blocked = vehicle.status === 'blacklisted' || vehicle.status === 'removed';

  async function verify() {
    setError(null);
    try {
      const result = await api.post<{ status: string; token: string }>(
        `/vehicles/${vehicle.id}/verify`,
        {
          ownerLabel: ownerLabel.trim() || 'Resident',
          ...(unitNumber.trim() ? { unitNumber: unitNumber.trim() } : {}),
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      await onVerified(result.token);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The vehicle was not verified.',
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden />
          {reissue ? 'Reissue gate credential' : 'Verify and issue gate credential'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm text-pretty">
          {reissue
            ? 'This vehicle is verified. Verifying again issues a new gate credential and the current one stops working at once — use it when a pass is lost or compromised.'
            : 'Verifying marks the vehicle active and issues its gate credential: a QR the gate scans to admit it. The credential is shown once, here, and cannot be retrieved later.'}
        </p>

        {blocked ? (
          <Alert tone="danger">
            {vehicle.status === 'blacklisted'
              ? 'A blacklisted vehicle cannot be verified. Reinstate it first.'
              : 'A removed vehicle cannot be verified.'}
          </Alert>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Label on the pass"
                hint="What the officer sees beside the plate."
                maxLength={60}
                value={ownerLabel}
                onChange={(event) => setOwnerLabel(event.target.value)}
              />
              <Input
                label="Unit number"
                hint="Shown on the pass so the officer knows where it is going."
                maxLength={20}
                value={unitNumber}
                onChange={(event) => setUnitNumber(event.target.value)}
              />
            </div>

            {error && <Alert tone="danger">{error}</Alert>}

            <ConfirmDialog
              trigger={
                <Button variant={reissue ? 'danger' : 'success'}>
                  <ShieldCheck aria-hidden />
                  {reissue ? 'Reissue credential' : 'Verify vehicle'}
                </Button>
              }
              title={
                reissue
                  ? `Reissue ${vehicle.plateNumber}'s credential?`
                  : `Verify ${vehicle.plateNumber}?`
              }
              description={
                reissue
                  ? 'A new gate credential is issued and the existing one is revoked immediately. Whoever holds the old QR will be refused at the gate.'
                  : 'The vehicle becomes active and a gate credential is issued. You will see it once, on this page — be ready to hand it to the owner.'
              }
              confirmLabel={reissue ? 'Reissue' : 'Verify'}
              tone={reissue ? 'danger' : 'primary'}
              onConfirm={verify}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Amend what is on record.
 *
 * Only changed fields are sent. Cleared optional fields go as null, which is
 * how the API tells "remove this" from "leave it alone". A plate change is
 * called out before saving because it retires the current gate credential.
 */
function EditVehicleDialog({
  vehicle,
  onSaved,
}: {
  vehicle: Vehicle;
  onSaved: (token: string | undefined, plateNumber: string) => Promise<void>;
}) {
  const initial = useCallback(
    () => ({
      plateNumber: vehicle.plateNumber,
      make: vehicle.make,
      model: vehicle.model,
      colour: vehicle.colour,
      year: vehicle.year === null ? '' : String(vehicle.year),
      type: vehicle.type,
      driverName: vehicle.driverName ?? '',
      driverPhone: vehicle.driverPhone ?? '',
      insuranceProvider: vehicle.insuranceProvider ?? '',
      insuranceExpiryDate: vehicle.insuranceExpiryDate
        ? vehicle.insuranceExpiryDate.slice(0, 10)
        : '',
    }),
    [vehicle],
  );

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = initial();
  const plateChanged = form.plateNumber.trim().toUpperCase() !== vehicle.plateNumber.toUpperCase();

  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    for (const key of ['plateNumber', 'make', 'model', 'colour'] as const) {
      if (form[key].trim() !== base[key]) patch[key] = form[key].trim();
    }
    for (const key of ['driverName', 'driverPhone', 'insuranceProvider'] as const) {
      if (form[key].trim() !== base[key]) patch[key] = form[key].trim() || null;
    }
    if (form.type !== base.type) patch.type = form.type;
    if (form.year !== base.year) patch.year = form.year ? Number(form.year) : null;
    if (form.insuranceExpiryDate !== base.insuranceExpiryDate) {
      patch.insuranceExpiryDate = form.insuranceExpiryDate || null;
    }

    return patch;
  }

  const dirty = Object.keys(buildPatch()).length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.patch<{ plateNumber: string; credentialToken?: string }>(
        `/vehicles/${vehicle.id}`,
        buildPatch(),
      );
      setOpen(false);
      await onSaved(result.credentialToken, result.plateNumber);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'The changes were not saved.');
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof ReturnType<typeof initial>) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setForm(initial());
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={vehicle.status === 'removed'}>
          <Pencil aria-hidden />
          Edit
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {vehicle.plateNumber}</DialogTitle>
          <DialogDescription>
            Description changes reach the gate pass straight away. The owner cannot be changed here
            — register the vehicle to the new owner instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            label="Plate number"
            required
            minLength={3}
            maxLength={20}
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
            {...field('plateNumber')}
          />

          {plateChanged && vehicle.verifiedAt && (
            <Alert tone="warning" title="The gate credential will be reissued">
              The plate is the credential&rsquo;s identity. Saving revokes the current QR and shows
              a replacement once, on this page.
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Make" required maxLength={40} {...field('make')} />
            <Input label="Model" required maxLength={40} {...field('model')} />
            <Input label="Colour" required minLength={2} maxLength={30} {...field('colour')} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-foreground block text-sm font-medium">Type</span>
              <select
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value as VehicleType })}
                className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm capitalize focus-visible:ring-2 focus-visible:outline-none"
              >
                {VEHICLE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <Input label="Year" type="number" min={1900} max={2100} {...field('year')} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Driver name" maxLength={80} {...field('driverName')} />
            <Input label="Driver phone" type="tel" maxLength={20} {...field('driverPhone')} />
            <Input label="Insurer" maxLength={80} {...field('insuranceProvider')} />
            <Input label="Insurance expires" type="date" {...field('insuranceExpiryDate')} />
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!dirty}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Remove the vehicle from the register.
 *
 * Revokes its gate credential in the same call, and is refused by the API while
 * the car is inside the estate — that message is shown as-is, because it says
 * exactly what to do next.
 */
function RemoveCard({ vehicle, onRemoved }: { vehicle: Vehicle; onRemoved: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setError(null);
    try {
      await api.delete(
        `/vehicles/${vehicle.id}?${new URLSearchParams({ reason: reason.trim() }).toString()}`,
        { idempotencyKey: crypto.randomUUID() },
      );
      onRemoved();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'The vehicle was not removed.');
    }
  }

  if (vehicle.status === 'removed') return null;

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="text-danger flex items-center gap-2">
          <Trash2 className="size-4" aria-hidden />
          Remove from the register
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          label="Reason"
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Sold, written off, registered in error…"
        />

        {error && (
          <Alert tone="danger" title="Nothing was changed">
            {error}
          </Alert>
        )}

        <ConfirmDialog
          trigger={
            <Button variant="danger" disabled={reason.trim().length < 3}>
              <Ban aria-hidden />
              Remove vehicle
            </Button>
          }
          title={`Remove ${vehicle.plateNumber}?`}
          description="Its gate credential is revoked immediately and the car will no longer be admitted. The gate log keeps its past movements. There is no way to restore it from the app — it would have to be registered again."
          confirmLabel="Remove"
          tone="danger"
          confirmPhrase={vehicle.plateNumber}
          onConfirm={remove}
        />
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
