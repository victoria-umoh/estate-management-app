'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Building2,
  CarFront,
  ClipboardList,
  Home,
  ScanLine,
  Siren,
  UserCheck,
  Users,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The landing screen.
 *
 * The server decides which blocks a caller may see and sends only those, so
 * this renders whatever arrives rather than checking permissions itself. A
 * chairman who is also a resident gets both, in the order that matters: things
 * demanding a decision first, then things worth knowing.
 *
 * Emergencies outrank everything. If one is live, nothing else on this screen
 * is what the reader needs.
 */
interface Dashboard {
  resident?: {
    outstandingMinor: number;
    unpaidInvoices: number;
    activeVisitorPasses: number;
    visitorsInsideNow: number;
    householdSize: number;
    openRequests: number;
    unitNumber: string | null;
  };
  security?: {
    visitorsInside: number;
    overstaying: number;
    activeEmergencies: number;
    openIncidents: number;
    movementsToday: number;
    deniedToday: number;
  };
  estate?: {
    residents: number;
    pendingApprovals: number;
    properties: number;
    occupiedProperties: number;
    openIncidents: number;
    openRequests: number;
  };
  finance?: {
    outstandingMinor: number;
    collectedMinor: number;
    overdueInvoices: number;
  };
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Dashboard>('/dashboard'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>

      {data === null ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[86px] rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {/* Nothing else matters while one of these is live. */}
          {(data.security?.activeEmergencies ?? 0) > 0 && (
            <Card className="border-danger">
              <CardContent className="flex flex-wrap items-center gap-3 p-4 pt-4">
                <span className="bg-danger-muted text-danger grid size-10 shrink-0 place-items-center rounded-lg">
                  <Siren className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-danger font-medium">
                    {data.security?.activeEmergencies} active{' '}
                    {data.security?.activeEmergencies === 1 ? 'emergency' : 'emergencies'}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    Someone in the estate has raised an alarm.
                  </p>
                </div>
                <Button variant="danger" asChild>
                  <Link href="/security/emergencies">
                    Respond <ArrowRight aria-hidden />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {(data.estate?.pendingApprovals ?? 0) > 0 && (
            <Card className="border-warning">
              <CardContent className="flex flex-wrap items-center gap-3 p-4 pt-4">
                <span className="bg-warning-muted text-warning grid size-10 shrink-0 place-items-center rounded-lg">
                  <UserCheck className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {data.estate?.pendingApprovals} resident
                    {data.estate?.pendingApprovals === 1 ? '' : 's'} awaiting approval
                  </p>
                  <p className="text-muted-foreground text-sm">
                    They cannot be issued an ID or use the gate until reviewed.
                  </p>
                </div>
                <Button variant="outline" asChild>
                  <Link href="/admin/residents">Review</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {data.resident && (
            <Section
              title={
                data.resident.unitNumber ? `Your home · ${data.resident.unitNumber}` : 'Your home'
              }
            >
              <Tile
                icon={<Banknote aria-hidden />}
                label={
                  data.resident.unpaidInvoices === 1
                    ? '1 unpaid invoice'
                    : `${data.resident.unpaidInvoices} unpaid invoices`
                }
                value={formatMoney(data.resident.outstandingMinor)}
                tone={data.resident.outstandingMinor > 0 ? 'warning' : 'neutral'}
                href="/my/payments"
              />
              <Tile
                icon={<Users aria-hidden />}
                label="Visitor passes open"
                value={data.resident.activeVisitorPasses}
                badge={
                  data.resident.visitorsInsideNow > 0
                    ? `${data.resident.visitorsInsideNow} inside`
                    : undefined
                }
                href="/my/visitors"
              />
              <Tile
                icon={<Home aria-hidden />}
                label="In your household"
                value={data.resident.householdSize}
                href="/my/household"
              />
              <Tile
                icon={<Wrench aria-hidden />}
                label="Open requests"
                value={data.resident.openRequests}
                href="/my/property"
              />
            </Section>
          )}

          {data.security && (
            <Section
              title="At the gate"
              action={
                <Button size="sm" asChild>
                  <Link href="/security/scan">
                    <ScanLine aria-hidden /> Scanner
                  </Link>
                </Button>
              }
            >
              <Tile
                icon={<Users aria-hidden />}
                label="Visitors inside"
                value={data.security.visitorsInside}
                href="/security"
              />
              <Tile
                icon={<AlertTriangle aria-hidden />}
                label="Overstaying"
                value={data.security.overstaying}
                tone={data.security.overstaying > 0 ? 'warning' : 'neutral'}
                href="/security"
              />
              <Tile
                icon={<CarFront aria-hidden />}
                label="Movements today"
                value={data.security.movementsToday}
                badge={
                  data.security.deniedToday > 0 ? `${data.security.deniedToday} denied` : undefined
                }
                href="/security/activity"
              />
              <Tile
                icon={<ClipboardList aria-hidden />}
                label="Open incidents"
                value={data.security.openIncidents}
                href="/admin/incidents"
              />
            </Section>
          )}

          {data.estate && (
            <Section title="The estate">
              <Tile
                icon={<Users aria-hidden />}
                label="Active residents"
                value={data.estate.residents}
                href="/admin/residents"
              />
              <Tile
                icon={<Building2 aria-hidden />}
                label="Properties occupied"
                value={`${data.estate.occupiedProperties}/${data.estate.properties}`}
                href="/admin/properties"
              />
              <Tile
                icon={<ClipboardList aria-hidden />}
                label="Open incidents"
                value={data.estate.openIncidents}
                href="/admin/incidents"
              />
              <Tile
                icon={<Wrench aria-hidden />}
                label="Open requests"
                value={data.estate.openRequests}
                href="/admin/requests"
              />
            </Section>
          )}

          {data.finance && (
            <Section title="Money">
              <Tile
                icon={<Banknote aria-hidden />}
                label="Outstanding"
                value={formatMoney(data.finance.outstandingMinor)}
                tone={data.finance.outstandingMinor > 0 ? 'warning' : 'neutral'}
                href="/admin/finance"
              />
              <Tile
                icon={<Banknote aria-hidden />}
                label="Collected"
                value={formatMoney(data.finance.collectedMinor)}
                href="/admin/finance"
              />
              <Tile
                icon={<AlertTriangle aria-hidden />}
                label="Overdue invoices"
                value={data.finance.overdueInvoices}
                tone={data.finance.overdueInvoices > 0 ? 'warning' : 'neutral'}
                href="/admin/finance"
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
      </CardContent>
    </Card>
  );
}

function Tile({
  icon,
  label,
  value,
  badge,
  tone = 'neutral',
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  badge?: string;
  tone?: 'neutral' | 'warning';
  href: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'border-border hover:border-primary/40 hover:bg-accent/40 group rounded-xl border p-3 transition-colors',
        tone === 'warning' && 'border-warning/50',
      )}
    >
      <span
        className={cn(
          'mb-2 grid size-8 place-items-center rounded-lg [&_svg]:size-4',
          tone === 'neutral' && 'bg-muted text-muted-foreground',
          tone === 'warning' && 'bg-warning-muted text-warning',
        )}
      >
        {icon}
      </span>
      <p className="truncate text-xl leading-none font-semibold tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-1.5 truncate text-xs">{label}</p>
      {badge && (
        <Badge tone="warning" size="sm" className="mt-2">
          {badge}
        </Badge>
      )}
    </Link>
  );
}

function formatMoney(minorUnits: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}
