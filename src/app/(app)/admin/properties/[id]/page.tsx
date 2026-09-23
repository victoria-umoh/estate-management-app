'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';

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

export default function PropertyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

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
    </div>
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
