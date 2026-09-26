'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * Scheduled reports: one table of one report, emailed as CSV on a cadence.
 *
 * The section draws itself only once the list loads. `report.schedule` is its
 * own permission, and someone who can read reports but not schedule them should
 * see the reports screen as it was, not a panel explaining what they lack.
 *
 * Only reports the viewer can export are offered. The service refuses the rest
 * — a schedule performs the export on its owner's behalf, so it may not reach
 * anything they could not download by hand.
 *
 * The API edits a schedule only by pausing or resuming it. Changing the cadence
 * or recipients means deleting and creating again, and the screen says so
 * rather than offering an edit form that would do the same thing invisibly.
 */
export interface SchedulableReport {
  type: string;
  title: string;
  canExport: boolean;
}

interface Schedule {
  id: string;
  reportType: string;
  tableId: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  recipients: string[];
  active: boolean;
  lastRunAt: string | null;
  lastRunStatus: 'sent' | 'skipped' | 'failed' | null;
  lastRunDetail: string | null;
  nextRunAt: string;
}

/** The report types the schedule route accepts. */
const SCHEDULABLE = new Set(['collections', 'gate-activity', 'residents', 'incidents', 'visitors']);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const RUN_TONE = { sent: 'success', skipped: 'warning', failed: 'danger' } as const;

const SELECT_CLASS =
  'border-input bg-background h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

export function ReportSchedules({ catalogue }: { catalogue: SchedulableReport[] }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchedules(await api.get<Schedule[]>('/reports/schedules'));
      setFailed(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 403) setHidden(true);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportable = catalogue.filter((entry) => entry.canExport && SCHEDULABLE.has(entry.type));
  const titleOf = (type: string) =>
    catalogue.find((entry) => entry.type === type)?.title ?? type.replace(/-/g, ' ');

  async function setActive(schedule: Schedule, active: boolean) {
    try {
      await api.patch(`/reports/schedules/${schedule.id}`, { active });
      toast.success(active ? 'Schedule resumed.' : 'Schedule paused.');
      await load();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'That did not work.');
    }
  }

  async function remove(schedule: Schedule) {
    try {
      await api.delete(`/reports/schedules/${schedule.id}`);
      toast.success('Schedule deleted.');
      await load();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'That did not work.');
    }
  }

  if (hidden) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4" aria-hidden />
          Scheduled reports
        </CardTitle>
        {schedules !== null && exportable.length > 0 && (
          <CreateScheduleDialog reports={exportable} onCreated={() => void load()} />
        )}
      </CardHeader>
      <CardContent>
        {failed ? (
          <Alert
            tone="danger"
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            Could not load the schedules.
          </Alert>
        ) : schedules === null ? (
          <SkeletonTable rows={2} columns={3} />
        ) : schedules.length === 0 ? (
          <EmptyState
            icon={<CalendarClock aria-hidden />}
            title="Nothing scheduled"
            description={
              exportable.length > 0
                ? 'Have a report table emailed as a CSV every day, week or month.'
                : 'Scheduling needs a report you are able to export yourself.'
            }
          />
        ) : (
          <ul className="divide-border divide-y">
            {schedules.map((schedule) => (
              <li key={schedule.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{titleOf(schedule.reportType)}</span>
                    <Badge tone="neutral" size="sm">
                      {schedule.tableId}
                    </Badge>
                    {!schedule.active && (
                      <Badge tone="warning" size="sm" dot>
                        paused
                      </Badge>
                    )}
                    {schedule.lastRunStatus && (
                      <Badge tone={RUN_TONE[schedule.lastRunStatus]} size="sm" dot>
                        last {schedule.lastRunStatus}
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {describeCadence(schedule)} · to {schedule.recipients.join(', ')}
                  </p>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {schedule.active ? `Next ${formatWhen(schedule.nextRunAt)}` : 'Not running'}
                    {schedule.lastRunAt && ` · last ${formatWhen(schedule.lastRunAt)}`}
                    {schedule.lastRunDetail && ` — ${schedule.lastRunDetail}`}
                  </p>
                </div>

                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void setActive(schedule, !schedule.active)}
                  >
                    {schedule.active ? <Pause aria-hidden /> : <Play aria-hidden />}
                    {schedule.active ? 'Pause' : 'Resume'}
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" aria-label="Delete schedule">
                        <Trash2 aria-hidden />
                      </Button>
                    }
                    title="Delete this schedule?"
                    description={`${schedule.recipients.length === 1 ? 'Its recipient receives' : `Its ${schedule.recipients.length} recipients receive`} nothing further. This cannot be undone — pause it instead to stop it for now.`}
                    confirmLabel="Delete"
                    tone="danger"
                    onConfirm={() => remove(schedule)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        {schedules !== null && schedules.length > 0 && (
          <p className="text-muted-foreground mt-3 text-xs">
            To change a schedule&rsquo;s timing or recipients, delete it and create a new one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CreateScheduleDialog({
  reports,
  onCreated,
}: {
  reports: SchedulableReport[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reportType, setReportType] = useState(reports[0]?.type ?? '');
  const [tables, setTables] = useState<Array<{ id: string; label: string }> | null>(null);
  const [tableId, setTableId] = useState('');
  const [cadence, setCadence] = useState<Schedule['cadence']>('weekly');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [hour, setHour] = useState(7);
  const [recipients, setRecipients] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A report's tables are only known by running it, so the answer is kept per
  // type for as long as the dialog lives rather than re-run on every switch.
  const tableCache = useRef(new Map<string, Array<{ id: string; label: string }>>());

  useEffect(() => {
    if (!open || !reportType) return;

    const cached = tableCache.current.get(reportType);
    if (cached) {
      setTables(cached);
      setTableId(cached[0]?.id ?? '');
      return;
    }

    let cancelled = false;
    setTables(null);

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86_400_000);
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });

    api
      .get<{ tables: Array<{ id: string; label: string }> }>(`/reports/${reportType}?${query}`)
      .then((result) => {
        if (cancelled) return;
        const options = result.tables.map(({ id, label }) => ({ id, label }));
        tableCache.current.set(reportType, options);
        setTables(options);
        setTableId(options[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });

    return () => {
      cancelled = true;
    };
  }, [open, reportType]);

  const addresses = recipients
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter(Boolean);
  const badAddress = addresses.find((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  const valid =
    Boolean(reportType && tableId) && addresses.length > 0 && addresses.length <= 20 && !badAddress;

  function reset() {
    setReportType(reports[0]?.type ?? '');
    setCadence('weekly');
    setDayOfWeek(1);
    setDayOfMonth(1);
    setHour(7);
    setRecipients('');
    setError(null);
  }

  async function submit() {
    if (!valid) return;

    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post<{ nextRunAt: string }>('/reports/schedules', {
        reportType,
        tableId,
        cadence,
        ...(cadence === 'weekly' ? { dayOfWeek } : {}),
        ...(cadence === 'monthly' ? { dayOfMonth } : {}),
        hour,
        recipients: addresses,
      });
      toast.success('Report scheduled.', {
        description: `First run ${formatWhen(created.nextRunAt)}.`,
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not schedule it.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus aria-hidden />
          Schedule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a report</DialogTitle>
          <DialogDescription>
            Each run covers the period since the last one and is emailed as a CSV. It stops by
            itself if you later lose permission to export it.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-foreground space-y-1.5 text-sm font-medium">
              <span className="block">Report</span>
              <select
                value={reportType}
                onChange={(event) => setReportType(event.target.value)}
                className={SELECT_CLASS}
              >
                {reports.map((entry) => (
                  <option key={entry.type} value={entry.type}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-foreground space-y-1.5 text-sm font-medium">
              <span className="block">Table</span>
              <select
                value={tableId}
                onChange={(event) => setTableId(event.target.value)}
                disabled={!tables || tables.length === 0}
                className={SELECT_CLASS}
              >
                {tables === null && <option value="">Loading…</option>}
                {tables?.length === 0 && <option value="">No tables available</option>}
                {tables?.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-foreground space-y-1.5 text-sm font-medium">
              <span className="block">Every</span>
              <select
                value={cadence}
                onChange={(event) => setCadence(event.target.value as Schedule['cadence'])}
                className={SELECT_CLASS}
              >
                <option value="daily">Day</option>
                <option value="weekly">Week</option>
                <option value="monthly">Month</option>
              </select>
            </label>

            {cadence === 'weekly' && (
              <label className="text-foreground space-y-1.5 text-sm font-medium">
                <span className="block">On</span>
                <select
                  value={dayOfWeek}
                  onChange={(event) => setDayOfWeek(Number(event.target.value))}
                  className={SELECT_CLASS}
                >
                  {WEEKDAYS.map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {cadence === 'monthly' && (
              <label className="text-foreground space-y-1.5 text-sm font-medium">
                <span className="block">On day</span>
                <select
                  value={dayOfMonth}
                  onChange={(event) => setDayOfMonth(Number(event.target.value))}
                  className={SELECT_CLASS}
                >
                  {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="text-foreground space-y-1.5 text-sm font-medium">
              <span className="block">At</span>
              <select
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
                className={SELECT_CLASS}
              >
                {Array.from({ length: 24 }, (_, index) => index).map((value) => (
                  <option key={value} value={value}>
                    {String(value).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-muted-foreground -mt-2 text-xs">
            Hours are on the server&rsquo;s clock. The next run is shown in your own time once
            saved.
          </p>

          <Input
            label="Send to"
            required
            value={recipients}
            placeholder="treasurer@example.com, chair@example.com"
            hint="Up to 20 addresses, separated by commas. The file leaves the system — send it only to people entitled to it."
            error={
              badAddress
                ? `"${badAddress}" is not an email address`
                : addresses.length > 20
                  ? 'At most 20 recipients'
                  : undefined
            }
            onChange={(event) => setRecipients(event.target.value)}
          />

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!valid}>
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function describeCadence(schedule: Schedule): string {
  const at = `${String(schedule.hour).padStart(2, '0')}:00`;
  if (schedule.cadence === 'daily') return `Daily at ${at}`;
  if (schedule.cadence === 'weekly') return `${WEEKDAYS[schedule.dayOfWeek ?? 1]}s at ${at}`;
  return `Monthly on day ${schedule.dayOfMonth ?? 1} at ${at}`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
