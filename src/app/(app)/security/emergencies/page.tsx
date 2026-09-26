'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, MapPin, Phone, Siren } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Live emergencies.
 *
 * A life-safety screen, so it is built around one question: is anything
 * happening right now that nobody has acknowledged. Unacknowledged alerts come
 * first and are the only thing that gets full-width, coloured treatment.
 *
 * `/emergencies` returns active alerts only, so the history below the fold is
 * what this session has seen resolved rather than a full archive — stated on
 * the screen so nobody reads an empty list as "nothing ever happened here".
 *
 * Polls on the same 15s cadence as the security desk, and a failed poll is
 * swallowed once anything has rendered: a gate tablet drops its connection
 * routinely and blanking a live alert someone is acting on is not acceptable.
 */
interface Emergency {
  id: string;
  reference: string;
  type: string;
  status: string;
  description: string | null;
  location: string | null;
  coordinates: { lat: number; lng: number } | null;
  contactPhone: string | null;
  triggeredAt: string;
  acknowledgedAt: string | null;
  responseTimeSeconds: number | null;
}

const REFRESH_MS = 15_000;

const STATUS_TONE: Record<string, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  triggered: 'danger',
  acknowledged: 'warning',
  responding: 'info',
  resolved: 'success',
  'false-alarm': 'neutral',
};

export default function EmergenciesPage() {
  const [emergencies, setEmergencies] = useState<Emergency[] | null>(null);
  const [resolved, setResolved] = useState<Emergency[]>([]);
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Read inside the poll without making the poll depend on it.
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const active = await api.get<Emergency[]>('/emergencies');
      setEmergencies(active);
      loaded.current = true;
      setFailed(false);
    } catch {
      if (!loaded.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (emergency: Emergency, body: Record<string, unknown>) => {
      setBusyId(emergency.id);
      setActionError(null);
      try {
        const result = await api.post<{ status: string }>(`/emergencies/${emergency.id}`, body);
        if (result.status === 'resolved' || result.status === 'false-alarm') {
          setResolved((previous) => [{ ...emergency, status: result.status }, ...previous]);
        }
        await load();
      } catch {
        setActionError('That did not go through. Check the alert and try again.');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const unacknowledged = emergencies?.filter((item) => item.acknowledgedAt === null) ?? [];
  const inHand = emergencies?.filter((item) => item.acknowledgedAt !== null) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Emergencies</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {emergencies === null ? (
        <Card>
          <CardContent className="p-4 pt-4">
            <SkeletonTable rows={3} columns={3} />
          </CardContent>
        </Card>
      ) : emergencies.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={<CheckCircle2 aria-hidden />}
              title="No active emergencies"
              description="Panic alerts raised anywhere on the estate appear here within seconds."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {unacknowledged.map((emergency) => (
            <EmergencyCard
              key={emergency.id}
              emergency={emergency}
              busy={busyId === emergency.id}
              onAct={act}
            />
          ))}

          {inHand.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Being handled</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {inHand.map((emergency) => (
                  <EmergencyCard
                    key={emergency.id}
                    emergency={emergency}
                    busy={busyId === emergency.id}
                    onAct={act}
                    compact
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Below the fold on purpose: history, not a decision. */}
      {resolved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Closed in this session</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y">
              {resolved.map((emergency) => (
                <li key={emergency.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                  <Badge tone={STATUS_TONE[emergency.status] ?? 'neutral'} size="sm">
                    {emergency.status}
                  </Badge>
                  <span className="font-mono text-xs">{emergency.reference}</span>
                  <span className="flex-1">{emergency.type}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    raised {formatTime(emergency.triggeredAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EmergencyCard({
  emergency,
  busy,
  onAct,
  compact = false,
}: {
  emergency: Emergency;
  busy: boolean;
  onAct: (emergency: Emergency, body: Record<string, unknown>) => Promise<void>;
  compact?: boolean;
}) {
  const live = emergency.acknowledgedAt === null;

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[emergency.status] ?? 'danger'} dot pulse={live}>
          {emergency.type}
        </Badge>
        <span className="font-mono text-xs">{emergency.reference}</span>
        <Badge tone={STATUS_TONE[emergency.status] ?? 'neutral'} size="sm">
          {emergency.status}
        </Badge>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {timeAgo(emergency.triggeredAt)}
        </span>
      </div>

      <p className={cn('mt-2 text-sm', live && 'font-medium')}>
        {emergency.description ?? 'No detail given'}
      </p>

      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {emergency.location && (
          <span className="flex items-center gap-1">
            <MapPin className="size-3" aria-hidden />
            {emergency.location}
          </span>
        )}
        {emergency.coordinates && (
          <span className="tabular-nums">
            {emergency.coordinates.lat.toFixed(5)}, {emergency.coordinates.lng.toFixed(5)}
          </span>
        )}
        {emergency.contactPhone && (
          <a className="flex items-center gap-1 underline" href={`tel:${emergency.contactPhone}`}>
            <Phone className="size-3" aria-hidden />
            {emergency.contactPhone}
          </a>
        )}
        <span className="tabular-nums">raised {formatTime(emergency.triggeredAt)}</span>
        {emergency.acknowledgedAt ? (
          <span className="tabular-nums">
            acknowledged {formatTime(emergency.acknowledgedAt)}
            {emergency.responseTimeSeconds !== null &&
              ` · ${formatResponse(emergency.responseTimeSeconds)} to respond`}
          </span>
        ) : (
          <span className="text-danger font-medium">not yet acknowledged</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {emergency.acknowledgedAt === null && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void onAct(emergency, { action: 'acknowledge' })}
          >
            Acknowledge
          </Button>
        )}
        {emergency.status !== 'responding' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onAct(emergency, { action: 'responding' })}
          >
            On my way
          </Button>
        )}
        <ResolveDialog
          disabled={busy}
          onResolve={(outcome, falseAlarm) =>
            onAct(emergency, {
              action: 'resolve',
              outcome,
              falseAlarm,
            })
          }
        />
      </div>
    </>
  );

  if (compact) {
    return <div className="bg-muted rounded-lg p-3">{body}</div>;
  }

  return (
    <Card className="border-danger">
      <CardHeader>
        <CardTitle className="text-danger flex items-center gap-2">
          <Siren className="size-5" aria-hidden />
          Active emergency
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bg-danger-muted rounded-lg p-3">{body}</div>
      </CardContent>
    </Card>
  );
}

/**
 * Resolving needs a written outcome, so this is a dialog rather than a
 * ConfirmDialog — the outcome is the record of what actually happened.
 */
function ResolveDialog({
  disabled,
  onResolve,
}: {
  disabled: boolean;
  onResolve: (outcome: string, falseAlarm: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [falseAlarm, setFalseAlarm] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await onResolve(outcome.trim(), falseAlarm);
      setOpen(false);
      setOutcome('');
      setFalseAlarm(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Resolve
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve this emergency</DialogTitle>
          <DialogDescription>
            Say what happened. This is the record the estate keeps of the response.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          placeholder="Ambulance attended, resident stable"
          maxLength={2000}
          aria-label="Outcome"
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={falseAlarm}
            onChange={(event) => setFalseAlarm(event.target.checked)}
          />
          Mark as a false alarm
        </label>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button disabled={saving || outcome.trim().length < 2} onClick={() => void submit()}>
            {saving ? 'Resolving…' : 'Resolve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function formatResponse(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
