'use client';

import { useCallback, useEffect, useState } from 'react';
import { BedDouble, Home, MapPin, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * The resident's own unit.
 *
 * The co-occupant list carries a resident code, a category and nothing else.
 * That is the API refusing to hand a neighbour's name and number to whoever
 * lives upstairs, not a field that failed to load — so the list is presented as
 * a roll of codes with a line saying as much, rather than as rows of blanks
 * that read like a bug.
 */
interface Occupant {
  id: string;
  residentCode: string | null;
  category: string;
  isSelf: boolean;
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

export default function MyPropertyPage() {
  const [property, setProperty] = useState<Property | null>(null);
  const [failed, setFailed] = useState(false);
  const [unassigned, setUnassigned] = useState(false);

  const load = useCallback(async () => {
    try {
      setProperty(await api.get<Property>('/me/property'));
      setFailed(false);
      setUnassigned(false);
    } catch (error) {
      // A 404 here means no unit is linked to the membership yet, which is an
      // ordinary state for a pending resident rather than a failure.
      if (error instanceof ApiRequestError && error.status === 404) {
        setUnassigned(true);
      } else {
        setFailed(true);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  if (unassigned) {
    return (
      <ErrorState
        title="No property linked yet"
        description="Your membership has not been assigned to a unit. The estate office can link one for you."
      />
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">My property</h1>

      <Card>
        <CardContent className="space-y-4 p-5 pt-5">
          {property === null ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-3">
                <span className="bg-primary/10 text-primary grid size-12 shrink-0 place-items-center rounded-xl">
                  <Home className="size-6" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-2xl leading-tight font-semibold tabular-nums">
                    {property.unitNumber}
                  </p>
                  <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-sm">
                    <MapPin className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">
                      {property.block ? `Block ${property.block} · ` : ''}
                      {property.street}
                    </span>
                  </p>
                </div>
                <Badge tone={property.occupancyStatus === 'occupied' ? 'success' : 'neutral'} dot>
                  {humanise(property.occupancyStatus)}
                </Badge>
              </div>

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="Type" value={humanise(property.type)} />
                <Fact
                  label="Bedrooms"
                  value={property.bedrooms === null ? 'Not recorded' : String(property.bedrooms)}
                  icon={<BedDouble aria-hidden />}
                />
                <Fact
                  label="Occupants"
                  value={
                    property.maxOccupants === null
                      ? String(property.currentOccupantCount)
                      : `${property.currentOccupantCount} of ${property.maxOccupants}`
                  }
                  icon={<Users aria-hidden />}
                />
                <Fact label="Registered" value={formatDate(property.registeredAt)} />
              </dl>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Who else is registered here</CardTitle>
        </CardHeader>
        <CardContent>
          {property === null ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <ul className="divide-border divide-y">
                {property.occupants.map((occupant) => (
                  <li key={occupant.id} className="flex flex-wrap items-center gap-2 py-2.5">
                    <span className="font-mono text-sm tracking-wide">
                      {occupant.residentCode ?? '—'}
                    </span>
                    <Badge tone="neutral" size="sm">
                      {humanise(occupant.category)}
                    </Badge>
                    {occupant.isSelf && (
                      <Badge tone="primary" size="sm">
                        you
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>

              <p className="text-muted-foreground mt-4 text-xs">
                Residents sharing your unit are shown by resident code and category only. Names and
                contact details are withheld by design — ask the estate office if you need to reach
                someone.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-muted/50 rounded-lg p-3">
      <dt className="text-muted-foreground flex items-center gap-1 text-xs [&_svg]:size-3.5">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function humanise(value: string): string {
  const spaced = value.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
