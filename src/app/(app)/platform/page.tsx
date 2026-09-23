'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2, Clock, Home, ShieldAlert, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The platform console.
 *
 * Reads across every estate, which is the boundary the rest of this application
 * spends its effort enforcing — so the screen is deliberately built around
 * counts and status. There is nowhere to click through to a resident. A support
 * engineer needs to know an estate has 140 units and is three days from
 * suspension; they do not need its residents' names.
 *
 * Every read here writes an audit entry server-side. That is stated on the
 * screen rather than left implicit, because someone using this should know
 * their access is recorded before they browse, not after.
 */
interface Overview {
  estates: { total: number; trial: number; active: number; pastDue: number; suspended: number };
  units: number;
  residents: number;
  mrrMinor: number;
  expiringSoon: number;
}

interface EstateSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  planName: string;
  billingPeriod: string | null;
  daysRemaining: number | null;
  createdAt: string;
  units: number;
  residents: number;
  outstandingMinor: number;
  contactEmail: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  trial: 'info',
  active: 'success',
  'past-due': 'warning',
  suspended: 'danger',
  closed: 'neutral',
};

export default function PlatformPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [estates, setEstates] = useState<EstateSummary[] | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (search.trim()) query.set('search', search.trim());

    try {
      const [overviewResult, estatesResult] = await Promise.all([
        api.get<Overview>('/platform/overview'),
        api.get<EstateSummary[]>(`/platform/estates?${query}`),
      ]);

      setOverview(overviewResult);
      setEstates(estatesResult);
      setFailed(false);
    } catch (error) {
      // A 403 here is the common case — this route is reachable by anyone
      // signed in, and almost nobody is platform staff. Saying so beats a
      // generic failure.
      if (error instanceof ApiRequestError && error.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, [status, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setSuspended(estate: EstateSummary, suspended: boolean) {
    setProblem(null);

    try {
      await api.post(
        `/platform/estates/${estate.id}/suspend`,
        { suspended, reason },
        { idempotencyKey: crypto.randomUUID() },
      );
      setReason('');
      await load();
    } catch (error) {
      setProblem(error instanceof ApiRequestError ? error.message : 'That did not work.');
    }
  }

  if (denied) return <PermissionDeniedState action="use the platform console" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Platform</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every estate on this deployment. Reads here are recorded in the audit trail.
        </p>
      </div>

      {problem && (
        <Card className="border-danger">
          <CardContent className="text-danger p-4 pt-4 text-sm">{problem}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile icon={<Building2 aria-hidden />} label="Estates" value={overview?.estates.total} />
        <Tile icon={<Home aria-hidden />} label="Units" value={overview?.units} />
        <Tile icon={<Users aria-hidden />} label="Residents" value={overview?.residents} />
        <Tile
          icon={<Clock aria-hidden />}
          label="Expiring in 14 days"
          value={overview?.expiringSoon}
          tone={(overview?.expiringSoon ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <Tile
          icon={<AlertTriangle aria-hidden />}
          label="MRR"
          value={overview ? formatMoney(overview.mrrMinor) : undefined}
        />
      </div>

      {overview && (overview.estates.pastDue > 0 || overview.estates.suspended > 0) && (
        <Card className="border-warning">
          <CardContent className="flex flex-wrap items-center gap-3 p-4 pt-4 text-sm">
            <ShieldAlert className="text-warning size-5 shrink-0" aria-hidden />
            <span className="flex-1">
              {overview.estates.pastDue} in grace, {overview.estates.suspended} suspended. Both keep
              reading; only changes are paused.
            </span>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Estates</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name"
              className="max-w-56"
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="border-input bg-background h-10 rounded-md border px-3 text-sm"
            >
              <option value="">Any status</option>
              {['trial', 'active', 'past-due', 'suspended', 'closed'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {estates === null ? (
            <SkeletonTable rows={5} columns={4} />
          ) : estates.length === 0 ? (
            <EmptyState
              title="No estates match"
              description="Adjust the filters."
              variant="no-results"
            />
          ) : (
            <ul className="divide-border divide-y">
              {estates.map((estate) => (
                <li key={estate.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{estate.name}</span>
                      <Badge tone={STATUS_TONE[estate.status] ?? 'neutral'} size="sm" dot>
                        {estate.status}
                      </Badge>
                      <Badge tone="neutral" size="sm">
                        {estate.planName}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {estate.units} units · {estate.residents} residents · {estate.contactEmail}
                      {estate.daysRemaining !== null && ` · ${estate.daysRemaining}d remaining`}
                    </p>
                  </div>

                  {estate.outstandingMinor > 0 && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatMoney(estate.outstandingMinor)} owed
                    </span>
                  )}

                  <ConfirmDialog
                    title={
                      estate.status === 'suspended'
                        ? `Restore ${estate.name}?`
                        : `Suspend ${estate.name}?`
                    }
                    description={
                      estate.status === 'suspended'
                        ? 'The estate returns to active and can make changes again.'
                        : 'Reading keeps working, including the gate. Only changes are paused. This is recorded in the estate’s own audit trail.'
                    }
                    confirmLabel={estate.status === 'suspended' ? 'Restore' : 'Suspend'}
                    tone={estate.status === 'suspended' ? 'primary' : 'danger'}
                    {...(estate.status !== 'suspended' ? { confirmPhrase: estate.slug } : {})}
                    onConfirm={() => setSuspended(estate, estate.status !== 'suspended')}
                    trigger={
                      <Button
                        size="sm"
                        variant={estate.status === 'suspended' ? 'outline' : 'danger'}
                        disabled={reason.trim().length < 4}
                      >
                        {estate.status === 'suspended' ? 'Restore' : 'Suspend'}
                      </Button>
                    }
                  />
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 space-y-1.5">
            <label htmlFor="reason" className="text-muted-foreground text-xs">
              Reason — required before suspending or restoring, and recorded against the estate
            </label>
            <Input
              id="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Non-payment after grace period"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string | undefined;
  tone?: 'neutral' | 'warning';
}) {
  return (
    <Card className={cn(tone === 'warning' && 'border-warning')}>
      <CardContent className="flex items-center gap-3 p-4 pt-4">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
            tone === 'warning' && 'bg-warning-muted text-warning',
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xl leading-none font-semibold tabular-nums">
            {value ?? '—'}
          </p>
          <p className="text-muted-foreground mt-1 truncate text-xs">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function formatMoney(minorUnits: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}
