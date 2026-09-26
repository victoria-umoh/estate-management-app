'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';
import { ResidentPicker, type ResidentOption } from '../_components/resident-picker';

/**
 * One property.
 *
 * Current occupants and the occupancy history come from different endpoints and
 * are shown as different things, which matches how the data is stored: current
 * occupancy is a pointer that changes, history is append-only and is what a
 * dispute about who lived here in March is answered from.
 *
 * Both endpoints identify people by membership id alone, so the names are
 * resolved from the resident directory filtered to this property. A history
 * entry for someone who has since left will not resolve, and is shown by its id
 * rather than being hidden — an unnamed record still belongs in the history.
 *
 * Assigning and removing refetch everything rather than patching state: an
 * assignment closes the previous holder's record and moves the occupancy
 * status, and neither of those is in the response.
 */
interface Occupant {
  id: string;
  membershipId: string;
  role: string;
  startedAt: string;
  leaseEndDate: string | null;
}

interface Property {
  id: string;
  unitNumber: string;
  block: string | null;
  street: string;
  type: string;
  occupancyStatus: string;
  bedrooms: number | null;
  maxOccupants: number | null;
  currentOccupantCount: number;
  registeredAt: string;
  occupants: Occupant[];
}

interface HistoryEntry {
  id: string;
  membershipId: string;
  role: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  leaseStartDate: string | null;
  leaseEndDate: string | null;
}

interface Resident {
  membershipId: string;
  fullName: string;
}

const OCCUPANCY_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  vacant: 'neutral',
  'owner-occupied': 'success',
  'tenant-occupied': 'info',
  'under-construction': 'warning',
  unavailable: 'danger',
};

type OccupantRole = 'owner' | 'landlord' | 'tenant';

export default function PropertyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [property, setProperty] = useState<Property | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [toMembershipId, setToMembershipId] = useState('');
  const [endExistingTenancies, setEndExistingTenancies] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, historyResult, residents] = await Promise.all([
        api.get<Property>(`/properties/${id}`),
        api.get<HistoryEntry[]>(`/properties/${id}/history`),
        api.get<Resident[]>(`/residents?propertyId=${id}&limit=100`),
      ]);

      setProperty(detail);
      setHistory(historyResult);
      setNames(new Map(residents.map((resident) => [resident.membershipId, resident.fullName])));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function transfer() {
    setNotice(null);
    try {
      await api.post(`/properties/${id}/transfer`, {
        toMembershipId: toMembershipId.trim(),
        endExistingTenancies,
      });
      setToMembershipId('');
      setEndExistingTenancies(false);
      await load();
    } catch {
      setNotice('The transfer did not go through. Check the membership id and try again.');
    }
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  if (property === null) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-40" />
        <Card>
          <CardContent className="p-4 pt-4">
            <SkeletonText lines={5} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const overcrowded =
    property.maxOccupants !== null && property.currentOccupantCount > property.maxOccupants;

  return (
    <div className="space-y-5">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/admin/properties">
            <ArrowLeft aria-hidden />
            Properties
          </Link>
        </Button>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight tabular-nums">
            {property.unitNumber}
          </h1>
          <Badge tone={OCCUPANCY_TONE[property.occupancyStatus] ?? 'neutral'} dot>
            {property.occupancyStatus.replace(/-/g, ' ')}
          </Badge>
          <Badge tone="neutral">{property.type.replace(/-/g, ' ')}</Badge>
        </div>

        <p className="text-muted-foreground mt-1 text-sm">
          {property.block ? `${property.block} · ` : ''}
          {property.street}
        </p>
      </div>

      {notice && (
        <Card className="border-danger">
          <CardContent className="text-danger p-4 pt-4 text-sm">{notice}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Field label="Bedrooms">{property.bedrooms ?? '—'}</Field>
            <Field label="Occupant cap">{property.maxOccupants ?? 'none set'}</Field>
            <Field label="Occupants">
              <span className={overcrowded ? 'text-danger font-medium' : undefined}>
                {property.currentOccupantCount}
              </span>
              {overcrowded && (
                <Badge tone="danger" size="sm">
                  over cap
                </Badge>
              )}
            </Field>
            <Field label="Registered">{formatDate(property.registeredAt)}</Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current occupants</CardTitle>
        </CardHeader>
        <CardContent>
          {property.occupants.length === 0 ? (
            <EmptyState title="Nobody registered" description="This unit has no current holders." />
          ) : (
            <ul className="divide-border divide-y">
              {property.occupants.map((occupant) => (
                <li key={occupant.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <Link
                    href={`/admin/residents/${occupant.membershipId}`}
                    className="text-primary min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {names.get(occupant.membershipId) ?? occupant.membershipId}
                  </Link>
                  <Badge tone="neutral" size="sm">
                    {occupant.role}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    since {formatDate(occupant.startedAt)}
                  </span>
                  {occupant.leaseEndDate && (
                    <Badge tone="warning" size="sm">
                      lease ends {formatDate(occupant.leaseEndDate)}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Occupancy history</CardTitle>
        </CardHeader>
        <CardContent>
          {history === null ? (
            <SkeletonText lines={4} />
          ) : history.length === 0 ? (
            <EmptyState
              title="No history"
              description="Ownership and tenancy changes appear here."
            />
          ) : (
            <ul className="divide-border divide-y">
              {history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {names.get(entry.membershipId) ?? (
                      <span className="font-mono text-xs">{entry.membershipId}</span>
                    )}
                  </span>
                  <Badge tone="neutral" size="sm">
                    {entry.role}
                  </Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {formatDate(entry.startedAt)} –{' '}
                    {entry.endedAt ? formatDate(entry.endedAt) : 'current'}
                  </span>
                  {entry.endReason && (
                    <Badge tone="neutral" size="sm">
                      {entry.endReason.replace(/-/g, ' ')}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AssignOccupantCard property={property} names={names} onAssigned={load} />

      <Card>
        <CardHeader>
          <CardTitle>Transfer ownership</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            label="New owner membership id"
            hint="The membership id of the resident taking ownership. It is in the address bar of their resident page."
            value={toMembershipId}
            onChange={(event) => setToMembershipId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary mt-0.5 size-4 shrink-0"
              checked={endExistingTenancies}
              onChange={(event) => setEndExistingTenancies(event.target.checked)}
            />
            <span>
              End sitting tenancies as part of the sale
              <span className="text-muted-foreground block text-xs">
                Leave unticked if the tenants stay on under the new owner.
              </span>
            </span>
          </label>

          <ConfirmDialog
            trigger={
              <Button variant="danger" disabled={toMembershipId.trim().length === 0}>
                Transfer ownership
              </Button>
            }
            title="Transfer this property?"
            description={`Ownership of ${property.unitNumber} moves to the given membership and the current ownership record is closed.${
              endExistingTenancies ? ' Sitting tenancies will be ended.' : ''
            } This is recorded in the occupancy history and cannot be silently undone.`}
            confirmLabel="Transfer"
            tone="danger"
            confirmPhrase={property.unitNumber}
            onConfirm={transfer}
          />
        </CardContent>
      </Card>

      <RemovePropertyCard property={property} onRemoved={() => router.push('/admin/properties')} />
    </div>
  );
}

const ROLE_HINT: Record<OccupantRole, string> = {
  owner:
    'Holds title. To hand the unit to a buyer with the full sale record, use the transfer below.',
  landlord: 'Lets the unit out on the owner’s behalf.',
  tenant: 'Occupies the unit under a lease.',
};

/**
 * Put someone on the unit as owner, landlord or tenant.
 *
 * Each role has one current holder. Assigning a role that is already held
 * closes the existing holder's record as "transferred" — it is not added
 * alongside — so the confirm step names who is being replaced rather than
 * leaving that to be discovered in the history afterwards.
 */
function AssignOccupantCard({
  property,
  names,
  onAssigned,
}: {
  property: Property;
  names: Map<string, string>;
  onAssigned: () => Promise<void>;
}) {
  const [role, setRole] = useState<OccupantRole>('tenant');
  const [person, setPerson] = useState<ResidentOption | null>(null);
  const [leaseStartDate, setLeaseStartDate] = useState('');
  const [leaseEndDate, setLeaseEndDate] = useState('');
  const [occupantCount, setOccupantCount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const current = property.occupants.find((occupant) => occupant.role === role) ?? null;
  const currentName = current ? (names.get(current.membershipId) ?? 'the current holder') : null;
  const leaseInvalid = Boolean(
    leaseStartDate && leaseEndDate && new Date(leaseEndDate) <= new Date(leaseStartDate),
  );

  async function assign() {
    if (!person) return;
    setError(null);
    try {
      await api.post(`/properties/${property.id}`, {
        membershipId: person.membershipId,
        role,
        ...(role === 'tenant' && leaseStartDate ? { leaseStartDate } : {}),
        ...(role === 'tenant' && leaseEndDate ? { leaseEndDate } : {}),
        ...(occupantCount ? { occupantCount: Number(occupantCount) } : {}),
      });
      setPerson(null);
      setLeaseStartDate('');
      setLeaseEndDate('');
      setOccupantCount('');
      await onAssigned();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The assignment did not go through.',
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="size-4" aria-hidden />
          Assign an occupant
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <fieldset className="space-y-1.5">
          <legend className="text-foreground text-sm font-medium">Role</legend>
          <div className="flex flex-wrap gap-1.5">
            {(['owner', 'landlord', 'tenant'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={role === option}
                onClick={() => setRole(option)}
                className={
                  role === option
                    ? 'border-primary bg-primary-muted text-primary rounded-full border px-3 py-1 text-xs font-medium capitalize'
                    : 'border-input text-muted-foreground hover:bg-accent rounded-full border px-3 py-1 text-xs capitalize'
                }
              >
                {option}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{ROLE_HINT[role]}</p>
        </fieldset>

        <ResidentPicker
          label="Resident"
          hint="Search active residents by name or code."
          value={person}
          onChange={setPerson}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          {role === 'tenant' && (
            <>
              <Input
                label="Lease starts"
                type="date"
                value={leaseStartDate}
                onChange={(event) => setLeaseStartDate(event.target.value)}
              />
              <Input
                label="Lease ends"
                type="date"
                value={leaseEndDate}
                onChange={(event) => setLeaseEndDate(event.target.value)}
                error={leaseInvalid ? 'Must be after the start date.' : undefined}
              />
            </>
          )}
          <Input
            label="People living there"
            type="number"
            min={1}
            max={100}
            value={occupantCount}
            onChange={(event) => setOccupantCount(event.target.value)}
            hint={
              property.maxOccupants !== null
                ? `Cap is ${property.maxOccupants}; going over is flagged, not refused.`
                : undefined
            }
          />
        </div>

        {current && (
          <Alert tone="warning" title={`This unit already has a ${role}`}>
            {currentName}&rsquo;s {role} record will be closed as transferred when you assign
            someone new.
          </Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <ConfirmDialog
          trigger={
            <Button disabled={!person || leaseInvalid}>
              <UserPlus aria-hidden />
              Assign {role}
            </Button>
          }
          title={`Assign ${person?.fullName ?? 'this resident'} as ${role}?`}
          description={
            current
              ? `${currentName} stops being the ${role} of ${property.unitNumber} and ${person?.fullName ?? 'the new resident'} takes over. The change is written to the occupancy history.`
              : `${person?.fullName ?? 'The resident'} becomes the ${role} of ${property.unitNumber}. The change is written to the occupancy history.`
          }
          confirmLabel="Assign"
          tone={current ? 'danger' : 'primary'}
          onConfirm={assign}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Take the unit off the register.
 *
 * A soft delete the API refuses while anyone still holds the unit, so the
 * button is disabled in that case with the reason beside it rather than letting
 * the request fail. The reason typed here is what the audit record keeps.
 */
function RemovePropertyCard({
  property,
  onRemoved,
}: {
  property: Property;
  onRemoved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const occupied = property.occupants.length > 0;

  async function remove() {
    setError(null);
    try {
      await api.delete(
        `/properties/${property.id}?${new URLSearchParams({ reason: reason.trim() }).toString()}`,
        { idempotencyKey: crypto.randomUUID() },
      );
      onRemoved();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The property was not removed.',
      );
    }
  }

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle className="text-danger flex items-center gap-2">
          <Trash2 className="size-4" aria-hidden />
          Remove from the register
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {occupied ? (
          <p className="text-muted-foreground text-sm">
            {property.unitNumber} still has {property.occupants.length} current{' '}
            {property.occupants.length === 1 ? 'occupancy' : 'occupancies'}. End{' '}
            {property.occupants.length === 1 ? 'it' : 'them'} before removing the property.
          </p>
        ) : (
          <>
            <Input
              label="Reason"
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Demolished, merged with 12A, registered in error…"
            />

            {error && <Alert tone="danger">{error}</Alert>}

            <ConfirmDialog
              trigger={
                <Button variant="danger" disabled={reason.trim().length < 3}>
                  <Trash2 aria-hidden />
                  Remove property
                </Button>
              }
              title={`Remove ${property.unitNumber}?`}
              description="The unit disappears from the register, billing and resident screens. Its occupancy history and audit trail are kept, but there is no way to restore it from the app."
              confirmLabel="Remove"
              tone="danger"
              confirmPhrase={property.unitNumber}
              onConfirm={remove}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-sm tabular-nums">{children}</dd>
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
