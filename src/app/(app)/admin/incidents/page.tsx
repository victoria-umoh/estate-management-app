'use client';

import { useCallback, useEffect, useState } from 'react';
import { MapPin, Siren } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';

/**
 * The incident log.
 *
 * The API returns these sorted by severity rank then recency, and that order is
 * rendered untouched: sorting here on the severity *string* would put "low"
 * above "critical" and bury the thing that matters under a noise complaint.
 * Filtering is pushed to the server for the same reason — filtering a client
 * page would only ever filter the first hundred rows.
 */
type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

type IncidentStatus = 'open' | 'assigned' | 'investigating' | 'resolved' | 'closed' | 'escalated';

interface Incident {
  id: string;
  reference: string;
  category: string;
  severity: IncidentSeverity;
  title: string;
  status: IncidentStatus;
  location: string | null;
  occurredAt: string;
  assignedToMembershipId: string | null;
}

const CATEGORIES = [
  'theft',
  'security-breach',
  'suspicious-activity',
  'property-damage',
  'noise',
  'parking',
  'fire',
  'flood',
  'medical',
  'accident',
  'power',
  'water',
  'other',
] as const;

const STATUSES: IncidentStatus[] = [
  'open',
  'assigned',
  'investigating',
  'escalated',
  'resolved',
  'closed',
];

/** Highest first, matching the server's `severityRank`. */
const SEVERITIES: IncidentSeverity[] = ['critical', 'high', 'medium', 'low'];

const SEVERITY_TONE: Record<IncidentSeverity, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const STATUS_TONE: Record<IncidentStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'warning',
  assigned: 'info',
  investigating: 'info',
  escalated: 'danger',
  resolved: 'success',
  closed: 'neutral',
};

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<IncidentStatus | ''>('');
  const [category, setCategory] = useState<string>('');
  const [severity, setSeverity] = useState<IncidentSeverity | ''>('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (status) params.set('status', status);
      if (category) params.set('category', category);
      if (severity) params.set('severity', severity);

      setIncidents(await api.get<Incident[]>(`/incidents?${params.toString()}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [status, category, severity]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const filtering = status !== '' || category !== '' || severity !== '';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 pt-4 sm:grid-cols-3">
          <FilterSelect
            label="Status"
            value={status}
            onChange={(value) => setStatus(value as IncidentStatus | '')}
            options={STATUSES}
            anyLabel="Any status"
          />
          <FilterSelect
            label="Category"
            value={category}
            onChange={setCategory}
            options={CATEGORIES}
            anyLabel="Any category"
          />
          <FilterSelect
            label="Severity"
            value={severity}
            onChange={(value) => setSeverity(value as IncidentSeverity | '')}
            options={SEVERITIES}
            anyLabel="Any severity"
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-2 pt-2 sm:p-4 sm:pt-4">
          {incidents === null ? (
            <SkeletonTable rows={6} columns={4} />
          ) : incidents.length === 0 ? (
            <EmptyState
              icon={<Siren aria-hidden />}
              variant={filtering ? 'no-results' : 'empty'}
              title={filtering ? 'No incidents match those filters' : 'No incidents reported'}
              description={
                filtering
                  ? 'Widen the filters to see more.'
                  : 'Reported incidents appear here, most severe first.'
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {incidents.map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/admin/incidents/${incident.id}`}
                    className="hover:bg-accent focus-visible:ring-ring flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-2 py-2.5 focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Badge
                      tone={SEVERITY_TONE[incident.severity]}
                      dot
                      pulse={incident.severity === 'critical'}
                      size="sm"
                    >
                      {incident.severity}
                    </Badge>

                    <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                      {incident.reference}
                    </span>

                    <span className="min-w-0 flex-1 basis-40 truncate text-sm font-medium">
                      {incident.title}
                    </span>

                    <Badge tone="neutral" size="sm">
                      {incident.category}
                    </Badge>

                    <Badge tone={STATUS_TONE[incident.status]} size="sm">
                      {incident.status}
                    </Badge>

                    {incident.location && (
                      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                        <MapPin className="size-3" aria-hidden />
                        {incident.location}
                      </span>
                    )}

                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {formatWhen(incident.occurredAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  anyLabel: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-foreground block text-sm font-medium">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm capitalize focus-visible:ring-2 focus-visible:outline-none"
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const sameDay = new Date().toDateString() === date.toDateString();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
