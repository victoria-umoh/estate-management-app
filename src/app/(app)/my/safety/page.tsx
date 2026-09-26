'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Ambulance,
  Car,
  ChevronDown,
  ChevronRight,
  Flame,
  MapPin,
  Phone,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Siren,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Attachments } from '@/components/feature/attachments';
import { ApiRequestError, api, type PageMeta } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Safety: the emergency button, and incident reports.
 *
 * The two are kept visibly apart because they are different promises. An
 * emergency pages security now; an incident is a record the estate office
 * works through. Someone whose car was scratched overnight should not be
 * nudged towards the panic button, and someone who smells smoke should not be
 * filling in a form.
 *
 * The emergency button takes two deliberate acts — open it, then press and
 * hold — so a phone in a pocket cannot raise an alarm. Beyond that it asks for
 * nothing: the type is one tap, everything else is optional, and the alert is
 * sent without waiting on GPS.
 */

type EmergencyType = 'medical' | 'fire' | 'security' | 'police' | 'accident' | 'other';

/** What a resident is shown of a live alert — the server withholds the rest. */
interface ActiveEmergency {
  id: string;
  reference: string;
  type: EmergencyType;
  status: 'triggered' | 'acknowledged' | 'responding';
  triggeredAt: string;
  acknowledgedAt: string | null;
}

interface RaisedAlert {
  id: string;
  reference: string;
  type: EmergencyType;
  raisedAt: number;
}

interface IncidentSummary {
  id: string;
  reference: string;
  category: string;
  severity: string;
  title: string;
  status: string;
  location: string | null;
  occurredAt: string;
}

const EMERGENCY_TYPES: ReadonlyArray<readonly [EmergencyType, string, LucideIcon]> = [
  ['security', 'Intruder / threat', ShieldAlert],
  ['medical', 'Medical', Ambulance],
  ['fire', 'Fire', Flame],
  ['accident', 'Accident', Car],
  ['police', 'Police needed', Siren],
  ['other', 'Something else', TriangleAlert],
];

const INCIDENT_CATEGORIES = [
  ['suspicious-activity', 'Suspicious activity'],
  ['theft', 'Theft'],
  ['security-breach', 'Security breach'],
  ['property-damage', 'Property damage'],
  ['noise', 'Noise'],
  ['parking', 'Parking'],
  ['power', 'Power'],
  ['water', 'Water'],
  ['flood', 'Flood'],
  ['fire', 'Fire (now out)'],
  ['medical', 'Medical'],
  ['accident', 'Accident'],
  ['other', 'Something else'],
] as const;

const SEVERITIES = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['critical', 'Critical'],
] as const;

const INCIDENT_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  open: 'info',
  assigned: 'info',
  investigating: 'warning',
  escalated: 'danger',
  resolved: 'success',
  closed: 'neutral',
};

const SEVERITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

/**
 * Remembers which alert this tab raised, so a reload does not lose the status.
 *
 * Session storage and only the id and reference: it is a convenience for this
 * tab, and the server remains the source of what the alert's state is.
 */
const RAISED_KEY = 'safety.raised-alert';
const POLL_MS = 10_000;
const HOLD_MS = 2_000;

export default function MySafetyPage() {
  const [raised, setRaised] = useState<RaisedAlert | null>(null);
  const [active, setActive] = useState<ActiveEmergency[] | null>(null);
  // When the latest successful load was *requested*. An alert missing from a
  // list fetched before it was raised proves nothing; only a later one can
  // say it has been closed.
  const [loadedFrom, setLoadedFrom] = useState<number | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(RAISED_KEY);
      if (stored) setRaised(JSON.parse(stored) as RaisedAlert);
    } catch {
      // Storage unavailable: the alert still went out; only the tracking is lost.
    }
  }, []);

  const loadActive = useCallback(async () => {
    const requestedAt = Date.now();
    try {
      setActive(await api.get<ActiveEmergency[]>('/emergencies'));
      setLoadedFrom(requestedAt);
    } catch {
      // Keep the last answer rather than blanking a status someone is watching.
      setActive((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void loadActive();
    // Polled only while this tab is tracking an alert of its own; otherwise
    // the list is loaded once and is a courtesy, not a monitor.
    if (!raised) return;
    const timer = setInterval(() => void loadActive(), POLL_MS);
    return () => clearInterval(timer);
  }, [loadActive, raised]);

  function track(alert: RaisedAlert | null) {
    setRaised(alert);
    try {
      if (alert) sessionStorage.setItem(RAISED_KEY, JSON.stringify(alert));
      else sessionStorage.removeItem(RAISED_KEY);
    } catch {
      // As above: tracking is best-effort.
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Safety</h1>

      {raised ? (
        <RaisedAlertStatus
          alert={raised}
          live={active?.find((emergency) => emergency.id === raised.id) ?? null}
          confirmedSince={loadedFrom !== null && loadedFrom > raised.raisedAt}
          onDismiss={() => track(null)}
        />
      ) : (
        <EmergencyCard
          onRaised={(alert) => {
            track(alert);
            void loadActive();
          }}
        />
      )}

      <EstateAlerts active={active} mine={raised?.id ?? null} />

      <Incidents />
    </div>
  );
}

function EmergencyCard({ onRaised }: { onRaised: (alert: RaisedAlert) => void }) {
  return (
    <Card className="border-danger/40">
      <CardContent className="space-y-3 p-4 pt-4">
        <EmergencyDialog onRaised={onRaised} />
        <p className="text-muted-foreground text-center text-xs text-pretty">
          Alerts estate security immediately. For a problem that can wait, report an incident below
          instead.
        </p>
      </CardContent>
    </Card>
  );
}

function EmergencyDialog({ onRaised }: { onRaised: (alert: RaisedAlert) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<EmergencyType | null>(null);
  const [location, setLocation] = useState('');
  const [shareGps, setShareGps] = useState(false);
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsState, setGpsState] = useState<'idle' | 'finding' | 'ready' | 'unavailable'>('idle');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Guards against a second send while the first is in flight. The route is
  // not idempotent, so this is the only thing standing between a jittery hold
  // and two alerts.
  const inFlight = useRef(false);

  function reset() {
    setType(null);
    setLocation('');
    setShareGps(false);
    setCoordinates(null);
    setGpsState('idle');
    setFailed(null);
  }

  function toggleGps(next: boolean) {
    setShareGps(next);
    setCoordinates(null);

    if (!next) {
      setGpsState('idle');
      return;
    }

    // Asked for now, while the resident is still choosing, so the send never
    // waits on it. If it has not arrived by then the alert goes without it.
    if (!('geolocation' in navigator)) {
      setGpsState('unavailable');
      return;
    }

    setGpsState('finding');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoordinates({ lat: position.coords.latitude, lng: position.coords.longitude });
        setGpsState('ready');
      },
      () => setGpsState('unavailable'),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function send() {
    if (!type || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setFailed(null);

    try {
      const created = await api.post<{ id: string; reference: string; status: string }>(
        '/emergencies',
        {
          type,
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(shareGps && coordinates ? { coordinates } : {}),
        },
      );

      setOpen(false);
      reset();
      onRaised({ id: created.id, reference: created.reference, type, raisedAt: Date.now() });
    } catch (error) {
      setFailed(
        error instanceof ApiRequestError && error.status === 429
          ? 'Too many alerts in the last few minutes.'
          : 'The alert did not go through.',
      );
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Not dismissable mid-send: closing would hide whether it arrived.
        if (sending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="danger" size="xl" block className="h-20 text-xl">
          <Siren className="size-7" aria-hidden />
          Emergency
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>What is happening?</DialogTitle>
          <DialogDescription>
            Choose one, then press and hold the button to alert security.
          </DialogDescription>
        </DialogHeader>

        {failed && (
          <Alert tone="danger" title={failed}>
            Hold the button again to retry, or call for help directly.
            <a
              href="tel:112"
              className="text-danger mt-2 inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"
            >
              <Phone className="size-4" aria-hidden />
              Call 112
            </a>
          </Alert>
        )}

        <fieldset>
          <legend className="sr-only">Type of emergency</legend>
          <div className="grid grid-cols-2 gap-2">
            {EMERGENCY_TYPES.map(([value, label, Icon]) => (
              <label
                key={value}
                className={cn(
                  'flex min-h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border p-2 text-center text-sm font-medium transition-colors',
                  'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2',
                  type === value
                    ? 'border-danger bg-danger-muted text-danger'
                    : 'hover:bg-muted border-input',
                )}
              >
                <input
                  type="radio"
                  name="emergency-type"
                  value={value}
                  checked={type === value}
                  onChange={() => setType(value)}
                  className="sr-only"
                />
                <Icon className="size-5" aria-hidden />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <Input
          label="Where are you?"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          maxLength={200}
          hint="Optional — your home address is sent automatically"
          leadingIcon={<MapPin aria-hidden />}
        />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shareGps}
            onChange={(event) => toggleGps(event.target.checked)}
            className="accent-primary size-4"
          />
          Share my GPS location
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {gpsState === 'finding' && '· finding…'}
            {gpsState === 'ready' && '· ready'}
            {gpsState === 'unavailable' && '· not available'}
          </span>
        </label>

        <HoldToConfirm
          disabled={!type}
          busy={sending}
          onConfirm={() => void send()}
          label={type ? 'Hold to send alert' : 'Choose what is happening first'}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * A button that fires only after being held down.
 *
 * Works the same for pointer and keyboard: holding Space or Enter counts, and
 * letting go early cancels. Auto-repeating keydown events are ignored so the
 * timer is not restarted by the key held down. The context menu a long press
 * opens on mobile is suppressed, since that long press is the gesture.
 */
function HoldToConfirm({
  disabled,
  busy,
  label,
  onConfirm,
}: {
  disabled: boolean;
  busy: boolean;
  label: string;
  onConfirm: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const startedAt = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const confirm = useRef(onConfirm);

  useEffect(() => {
    confirm.current = onConfirm;
  }, [onConfirm]);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    startedAt.current = null;
    setProgress(0);
  }, []);

  useEffect(() => stop, [stop]);

  function begin() {
    if (disabled || busy || startedAt.current !== null) return;
    startedAt.current = performance.now();

    const tick = (now: number) => {
      if (startedAt.current === null) return;
      const next = Math.min(1, (now - startedAt.current) / HOLD_MS);
      setProgress(next);

      if (next >= 1) {
        frame.current = null;
        startedAt.current = null;
        setProgress(0);
        confirm.current();
        return;
      }

      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
  }

  const holding = progress > 0;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={disabled || busy}
        aria-describedby="hold-hint"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          begin();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          if (!event.repeat) begin();
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') stop();
        }}
        onBlur={stop}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          'bg-danger text-danger-foreground relative h-16 w-full touch-none overflow-hidden rounded-lg text-lg font-semibold select-none',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-black/25"
          style={{ width: `${progress * 100}%` }}
        />
        <span className="relative inline-flex items-center gap-2">
          <Siren className="size-5" aria-hidden />
          {busy ? 'Sending…' : holding ? 'Keep holding…' : label}
        </span>
      </button>
      <p id="hold-hint" className="text-muted-foreground text-center text-xs">
        Press and hold for 2 seconds. Let go to cancel.
      </p>
    </div>
  );
}

/**
 * The alert this resident raised, as the server currently sees it.
 *
 * Only live alerts are listed to residents, so an alert that drops off the list
 * has been closed by security — resolved or stood down. The screen says that
 * much and no more, since which of the two it was is not shown to residents.
 */
function RaisedAlertStatus({
  alert,
  live,
  confirmedSince,
  onDismiss,
}: {
  alert: RaisedAlert;
  live: ActiveEmergency | null;
  confirmedSince: boolean;
  onDismiss: () => void;
}) {
  const typeLabel = EMERGENCY_TYPES.find(([value]) => value === alert.type)?.[1] ?? alert.type;
  const closed = confirmedSince && live === null;

  const step = closed
    ? {
        tone: 'success' as const,
        title: 'Security has closed this alert',
        body: 'If you still need help, raise a new alert.',
      }
    : live?.status === 'responding'
      ? {
          tone: 'success' as const,
          title: 'Security is on the way',
          body: 'Stay where you are if it is safe to do so.',
        }
      : live?.status === 'acknowledged'
        ? {
            tone: 'warning' as const,
            title: 'Security has seen your alert',
            body: `Acknowledged ${live.acknowledgedAt ? formatTime(live.acknowledgedAt) : 'just now'}. They are deciding who to send.`,
          }
        : {
            tone: 'danger' as const,
            title: 'Alert sent — waiting for security',
            body: 'Estate security has been alerted. This updates on its own.',
          };

  return (
    <Card className={closed ? 'border-success/40' : 'border-danger/40'}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs">{alert.reference}</span>
          <Badge tone={closed ? 'neutral' : 'danger'} size="sm" dot pulse={!closed}>
            {closed ? 'closed' : (live?.status ?? 'triggered')}
          </Badge>
          <span className="text-muted-foreground ml-auto text-xs">{typeLabel}</span>
        </div>
        <CardTitle className="flex items-center gap-2">
          {closed ? (
            <ShieldCheck className="text-success size-5" aria-hidden />
          ) : (
            <Siren className="text-danger size-5" aria-hidden />
          )}
          Your emergency alert
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div aria-live="polite">
          <Alert tone={step.tone} title={step.title}>
            {step.body}
          </Alert>
        </div>

        {live && (
          <p className="text-muted-foreground text-xs tabular-nums">
            Raised {formatTime(live.triggeredAt)}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" block asChild>
            <a href="tel:112">
              <Phone aria-hidden />
              Call 112
            </a>
          </Button>
          {closed && (
            <Button block onClick={onDismiss}>
              Done
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Live alerts across the estate — the kind and the time, nothing identifying. */
function EstateAlerts({ active, mine }: { active: ActiveEmergency[] | null; mine: string | null }) {
  const others = active?.filter((emergency) => emergency.id !== mine) ?? [];
  if (others.length === 0) return null;

  return (
    <Alert
      tone="warning"
      title={`${others.length} live alert${others.length === 1 ? '' : 's'} on the estate`}
    >
      <ul className="mt-1 space-y-0.5">
        {others.map((emergency) => (
          <li key={emergency.id} className="tabular-nums">
            {EMERGENCY_TYPES.find(([value]) => value === emergency.type)?.[1] ?? emergency.type} ·
            since {formatTime(emergency.triggeredAt)} · {emergency.status}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

const INCIDENT_PAGE_SIZE = 10;

function Incidents() {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [justReported, setJustReported] = useState<{ id: string; reference: string } | null>(null);

  const load = useCallback(async () => {
    try {
      // No reporter filter: without `incident.viewAll` the server returns only
      // incidents this caller reported or was named in.
      const result = await api.getPage<IncidentSummary>(
        `/incidents?page=${page}&limit=${INCIDENT_PAGE_SIZE}`,
      );
      setIncidents(result.items);
      setMeta(result.meta);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>Incidents</CardTitle>
          <CardDescription>For the estate office to look into — not urgent help.</CardDescription>
        </div>
        <ReportIncidentDialog
          onReported={(created) => {
            toast.success(`Incident ${created.reference} reported`);
            setJustReported(created);
            setExpanded(created.id);
            setPage(1);
            void load();
          }}
        />
      </CardHeader>

      <CardContent className="space-y-3">
        {justReported && (
          <Alert
            tone="success"
            title={`Reported as ${justReported.reference}`}
            action={
              <Button variant="ghost" size="sm" onClick={() => setJustReported(null)}>
                Dismiss
              </Button>
            }
          >
            Add photographs below if you have any — they help the office act on it.
          </Alert>
        )}

        {failed ? (
          <ErrorState onRetry={() => void load()} />
        ) : incidents === null ? (
          <SkeletonTable rows={3} columns={2} />
        ) : incidents.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck aria-hidden />}
            title="Nothing reported"
            description="Incidents you report — a break-in, damage, suspicious activity — are tracked here."
          />
        ) : (
          <ul className="divide-border divide-y">
            {incidents.map((incident) => {
              const open = expanded === incident.id;
              return (
                <li key={incident.id} className="py-2">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`incident-${incident.id}`}
                    onClick={() => setExpanded(open ? null : incident.id)}
                    className="hover:bg-muted/60 focus-visible:ring-ring -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{incident.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={INCIDENT_TONE[incident.status] ?? 'neutral'} size="sm" dot>
                          {incident.status}
                        </Badge>
                        <Badge tone={SEVERITY_TONE[incident.severity] ?? 'neutral'} size="sm">
                          {incident.severity}
                        </Badge>
                        <span className="text-muted-foreground font-mono text-xs">
                          {incident.reference}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                        {formatWhen(incident.occurredAt)}
                        {incident.location ? ` · ${incident.location}` : ''}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        'text-muted-foreground size-4 shrink-0 transition-transform',
                        open && 'rotate-180',
                      )}
                      aria-hidden
                    />
                  </button>

                  {open && (
                    <div id={`incident-${incident.id}`} className="mt-2 space-y-2">
                      <Link
                        href={`/my/safety/incidents/${incident.id}`}
                        className="text-primary inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                      >
                        Details and conversation
                        <ChevronRight className="size-4" aria-hidden />
                      </Link>
                      <Attachments
                        subjectType="incident"
                        subjectId={incident.id}
                        canUpload={incident.status !== 'closed'}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || incidents === null}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={incidents === null || !meta.hasNextPage}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReportIncidentDialog({
  onReported,
}: {
  onReported: (created: { id: string; reference: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [severity, setSeverity] = useState<string>('medium');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const occurred = text('occurredAt');

    if (occurred && new Date(occurred).getTime() > Date.now()) {
      setProblem('The time it happened cannot be in the future.');
      setBusy(false);
      return;
    }

    try {
      const created = await api.post<{ id: string; reference: string; status: string }>(
        '/incidents',
        {
          category: text('category'),
          severity,
          title: text('title'),
          description: text('description'),
          // Left out when blank; the server then records it as happening now.
          ...(occurred ? { occurredAt: new Date(occurred).toISOString() } : {}),
          ...(text('location') ? { location: text('location') } : {}),
        },
      );

      setOpen(false);
      setSeverity('medium');
      onReported(created);
    } catch (error) {
      setProblem(
        error instanceof ApiRequestError && error.status === 429
          ? 'You have reported a lot of incidents in the last hour. Please wait a little.'
          : error instanceof ApiRequestError && error.status < 500
            ? error.message
            : 'Could not send the report. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="shrink-0">
          <Plus aria-hidden />
          Report
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report an incident</DialogTitle>
          <DialogDescription>
            The estate office reviews reports and follows up. You can add photos once it is sent.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          <label className="block space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              What kind of incident?
              <span className="text-danger ml-0.5" aria-label="required">
                *
              </span>
            </span>
            <select
              name="category"
              required
              defaultValue=""
              className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <option value="" disabled>
                Choose one
              </option>
              {INCIDENT_CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <Input
            name="title"
            label="Short summary"
            required
            minLength={4}
            maxLength={160}
            placeholder="e.g. Car window smashed on Crescent Road"
          />

          <label className="block space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              What happened?
              <span className="text-danger ml-0.5" aria-label="required">
                *
              </span>
            </span>
            <textarea
              name="description"
              required
              minLength={4}
              maxLength={5000}
              rows={4}
              placeholder="What you saw, who was involved, and anything that would help."
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="occurredAt"
              label="When did it happen?"
              type="datetime-local"
              hint="Optional — defaults to now"
            />
            <Input name="location" label="Where?" maxLength={200} hint="Optional" />
          </div>

          <fieldset>
            <legend className="text-foreground mb-1.5 block text-sm font-medium">
              How serious is it?
            </legend>
            <div className="grid grid-cols-4 gap-1.5">
              {SEVERITIES.map(([value, label]) => (
                <label
                  key={value}
                  className="has-[:checked]:border-primary has-[:checked]:bg-primary-muted has-[:focus-visible]:ring-ring flex h-10 cursor-pointer items-center justify-center rounded-md border text-xs font-medium has-[:focus-visible]:ring-2"
                >
                  <input
                    type="radio"
                    name="severity"
                    value={value}
                    checked={severity === value}
                    onChange={() => setSeverity(value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Send report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
