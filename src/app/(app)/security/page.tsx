'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, ScanLine, Siren, Users } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The security desk.
 *
 * Ordered by urgency rather than by module: active emergencies first, then
 * overstaying visitors, then everyone currently inside, then the movement log.
 * A supervisor glancing at this should see the thing that needs a decision
 * before the thing that is merely informative.
 *
 * Polls rather than holding a socket. A tablet on a gate loses its connection
 * regularly, and a poll that silently resumes is more robust than a socket that
 * needs reconnection logic nobody will watch.
 */
interface InsideVisitor {
  id: string;
  code: string;
  visitorName: string;
  partySize: number;
  purpose: string;
  vehiclePlate: string | null;
  checkedInAt: string;
  expectedDeparture: string;
  overstaying: boolean;
  minutesOver: number;
}

interface Emergency {
  id: string;
  reference: string;
  type: string;
  status: string;
  description: string | null;
  location: string | null;
  triggeredAt: string;
}

interface Movement {
  id: string;
  direction: 'in' | 'out';
  subject: string;
  label: string;
  unitNumber: string | null;
  admitted: boolean;
  denialReason: string | null;
  method: string;
  occurredAt: string;
}

const REFRESH_MS = 15_000;

export default function SecurityDeskPage() {
  const [inside, setInside] = useState<InsideVisitor[] | null>(null);
  const [emergencies, setEmergencies] = useState<Emergency[] | null>(null);
  const [activity, setActivity] = useState<Movement[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [insideResult, emergencyResult, activityResult] = await Promise.all([
          api.get<InsideVisitor[]>('/security/inside'),
          api.get<Emergency[]>('/emergencies'),
          api.get<Movement[]>('/security/activity?limit=20'),
        ]);

        if (cancelled) return;

        setInside(insideResult);
        setEmergencies(emergencyResult);
        setActivity(activityResult);
        setFailed(false);
      } catch {
        // Only surfaced if nothing has loaded yet. A dropped poll on a gate
        // tablet is routine; wiping a screen the officer is reading is not.
        if (!cancelled && inside === null) setFailed(true);
      }
    }

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return <ErrorState onRetry={() => window.location.reload()} />;
  }

  const overstaying = inside?.filter((visitor) => visitor.overstaying) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Security desk</h1>
        <Button size="lg" asChild>
          <Link href="/security/scan">
            <ScanLine aria-hidden />
            Open scanner
          </Link>
        </Button>
      </div>

      {/* --- Emergencies: always first ------------------------------------ */}
      {emergencies && emergencies.length > 0 && (
        <Card className="border-danger">
          <CardHeader>
            <CardTitle className="text-danger flex items-center gap-2">
              <Siren className="size-5" aria-hidden />
              {emergencies.length} active {emergencies.length === 1 ? 'emergency' : 'emergencies'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {emergencies.map((emergency) => (
              <div
                key={emergency.id}
                className="bg-danger-muted flex flex-wrap items-center gap-2 rounded-lg p-3"
              >
                <Badge tone="danger" dot pulse>
                  {emergency.type}
                </Badge>
                <span className="font-mono text-xs">{emergency.reference}</span>
                <span className="flex-1 text-sm">
                  {emergency.location ?? emergency.description ?? 'No detail given'}
                </span>
                <span className="text-muted-foreground text-xs">
                  {timeAgo(emergency.triggeredAt)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* --- Counts -------------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile
          icon={<Users aria-hidden />}
          label="Visitors inside"
          value={inside?.length ?? null}
        />
        <StatTile
          icon={<AlertTriangle aria-hidden />}
          label="Overstaying"
          value={inside ? overstaying.length : null}
          tone={overstaying.length > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          icon={<Siren aria-hidden />}
          label="Emergencies"
          value={emergencies?.length ?? null}
          tone={(emergencies?.length ?? 0) > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {/* --- Overstays ----------------------------------------------------- */}
      {overstaying.length > 0 && (
        <Card className="border-warning">
          <CardHeader>
            <CardTitle className="text-warning">Overstaying visitors</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overstaying.map((visitor) => (
              <div key={visitor.id} className="bg-warning-muted rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{visitor.visitorName}</span>
                  <Badge tone="warning">{formatOverdue(visitor.minutesOver)} over</Badge>
                  <span className="text-muted-foreground font-mono text-xs">{visitor.code}</span>
                </div>
                <p className="text-muted-foreground mt-1 text-sm">
                  {visitor.purpose}
                  {visitor.vehiclePlate ? ` · ${visitor.vehiclePlate}` : ''}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* --- Currently inside ---------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Currently inside</CardTitle>
        </CardHeader>
        <CardContent>
          {inside === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : inside.length === 0 ? (
            <EmptyState title="No visitors inside" description="Checked-in visitors appear here." />
          ) : (
            <ul className="divide-border divide-y">
              {inside.map((visitor) => (
                <li key={visitor.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="flex-1 font-medium">{visitor.visitorName}</span>
                  {visitor.partySize > 1 && (
                    <Badge tone="neutral" size="sm">
                      party of {visitor.partySize}
                    </Badge>
                  )}
                  <Badge tone={visitor.overstaying ? 'warning' : 'success'} dot size="sm">
                    {visitor.overstaying ? 'overstaying' : 'inside'}
                  </Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    since {formatTime(visitor.checkedInAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- Recent activity ----------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Recent gate activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activity === null ? (
            <SkeletonTable rows={5} columns={3} />
          ) : activity.length === 0 ? (
            <EmptyState title="No activity yet" description="Gate events appear here." />
          ) : (
            <ul className="divide-border divide-y">
              {activity.map((movement) => (
                <li key={movement.id} className="flex items-center gap-2.5 py-2.5 text-sm">
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-full',
                      movement.admitted
                        ? 'bg-success-muted text-success'
                        : 'bg-danger-muted text-danger',
                    )}
                    aria-hidden
                  >
                    {movement.direction === 'in' ? (
                      <ArrowDownLeft className="size-3.5" />
                    ) : (
                      <ArrowUpRight className="size-3.5" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1 truncate font-medium">{movement.label}</span>

                  {movement.unitNumber && (
                    <span className="text-muted-foreground text-xs">{movement.unitNumber}</span>
                  )}

                  {!movement.admitted && (
                    <Badge tone="danger" size="sm">
                      {movement.denialReason ?? 'denied'}
                    </Badge>
                  )}

                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {formatTime(movement.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  return (
    <Card
      className={cn(tone === 'warning' && 'border-warning', tone === 'danger' && 'border-danger')}
    >
      <CardContent className="flex items-center gap-3 p-4 pt-4">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
            tone === 'warning' && 'bg-warning-muted text-warning',
            tone === 'danger' && 'bg-danger-muted text-danger',
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-2xl leading-none font-semibold tabular-nums">
            {value === null ? '—' : value}
          </p>
          <p className="text-muted-foreground mt-1 truncate text-xs">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatOverdue(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
