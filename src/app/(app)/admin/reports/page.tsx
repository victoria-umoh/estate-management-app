'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiRequestError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Reports.
 *
 * The catalogue is fetched rather than hardcoded: the server returns only the
 * reports this person may run, and whether they may export each one, so the
 * screen never offers a tile that would 403 on click. Export is its own flag
 * because it is its own permission — an estate manager reads the gate log here
 * and cannot carry it out as a file, which is the intended shape and not a bug.
 *
 * No chart library is loaded. `recharts` is installed but would land in the
 * shared chunk and the build enforces a first-load budget; a trend table reads
 * fine on a phone and costs nothing.
 */
interface ReportSummaryEntry {
  type: string;
  title: string;
  description: string;
  canView: boolean;
  canExport: boolean;
  exportPermission: string;
}

type ValueFormat = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'hours';

interface ReportColumn {
  key: string;
  label: string;
  format: ValueFormat;
}

interface ReportStat {
  key: string;
  label: string;
  value: number | string | null;
  format: ValueFormat;
  hint?: string;
}

interface ReportTableData {
  id: string;
  label: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
  totalRows: number;
  truncated: boolean;
}

interface ReportResult {
  type: string;
  title: string;
  description: string;
  range: { from: string; to: string };
  generatedAt: string;
  summary: ReportStat[];
  tables: ReportTableData[];
  withheldTables: string[];
  exportable: boolean;
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '12 months', days: 365 },
];

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return isoDay(new Date(Date.now() - days * 86_400_000));
}

export default function ReportsPage() {
  const [catalogue, setCatalogue] = useState<ReportSummaryEntry[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);

  const [type, setType] = useState<string | null>(null);
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => isoDay(new Date()));

  const [report, setReport] = useState<ReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const loadCatalogue = useCallback(async () => {
    try {
      const result = await api.get<{ reports: ReportSummaryEntry[] }>('/reports');
      const runnable = result.reports.filter((entry) => entry.canView);

      setCatalogue(runnable);
      setType((current) => current ?? runnable[0]?.type ?? null);
      setFailed(false);
      setDenied(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  const run = useCallback(async () => {
    if (!type) return;

    setRunning(true);
    setExportError(null);

    try {
      // The end date is inclusive: a range ending "today" that stopped at
      // midnight would silently drop everything that happened today.
      const query = new URLSearchParams({
        from: `${from}T00:00:00.000Z`,
        to: `${to}T23:59:59.999Z`,
      });
      setReport(await api.get<ReportResult>(`/reports/${type}?${query.toString()}`));
      setReportError(null);
    } catch (error) {
      setReport(null);
      setReportError(
        error instanceof ApiRequestError ? error.message : 'The report could not be run.',
      );
    } finally {
      setRunning(false);
    }
  }, [type, from, to]);

  useEffect(() => {
    void run();
  }, [run]);

  /**
   * Exports are fetched rather than linked.
   *
   * A plain anchor would navigate on a refusal and leave the person looking at
   * a raw JSON error page; fetching keeps the failure on this screen, where it
   * can say which permission is missing. The session cookie rides along with
   * the request either way.
   */
  const download = useCallback(
    async (tableId: string) => {
      if (!type) return;

      setExporting(tableId);
      setExportError(null);

      try {
        const query = new URLSearchParams({
          from: `${from}T00:00:00.000Z`,
          to: `${to}T23:59:59.999Z`,
          table: tableId,
          format: 'csv',
        });

        const response = await fetch(`/api/v1/reports/${type}/export?${query.toString()}`);

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setExportError(body?.error?.message ?? 'The export was refused.');
          return;
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');

        anchor.href = url;
        anchor.download =
          response.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ??
          `${type}-${tableId}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);

        if (response.headers.get('x-report-truncated') === 'true') {
          setExportError(
            `Only the first ${response.headers.get('x-report-rows')} of ${response.headers.get('x-report-total-rows')} rows were exported. Narrow the date range for the rest.`,
          );
        }
      } catch {
        setExportError('The export could not be downloaded.');
      } finally {
        setExporting(null);
      }
    },
    [type, from, to],
  );

  const selected = useMemo(
    () => catalogue?.find((entry) => entry.type === type) ?? null,
    [catalogue, type],
  );

  if (denied) return <PermissionDeniedState action="view reports" />;
  if (failed) return <ErrorState onRetry={() => void loadCatalogue()} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <Button variant="outline" onClick={() => void run()} disabled={running || !type}>
          {running ? 'Running…' : 'Refresh'}
        </Button>
      </div>

      {catalogue === null ? (
        <SkeletonTable rows={4} columns={3} />
      ) : catalogue.length === 0 ? (
        <EmptyState
          title="No reports available to you"
          description="Reports are gated on the data they cover — collections needs ledger access, gate activity needs the gate log."
        />
      ) : (
        <>
          {/* --- Which report ------------------------------------------------ */}
          <div className="flex flex-wrap gap-2">
            {catalogue.map((entry) => (
              <Button
                key={entry.type}
                size="sm"
                variant={entry.type === type ? 'primary' : 'outline'}
                onClick={() => setType(entry.type)}
              >
                {entry.title}
              </Button>
            ))}
          </div>

          {/* --- Over what period -------------------------------------------- */}
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 p-4 pt-4">
              <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                From
                <Input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                To
                <Input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>

              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.days}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setFrom(daysAgo(preset.days));
                      setTo(isoDay(new Date()));
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          {selected && <p className="text-muted-foreground text-sm">{selected.description}</p>}

          {exportError && <Alert tone="warning">{exportError}</Alert>}
          {reportError && <Alert tone="danger">{reportError}</Alert>}

          {running && report === null ? (
            <SkeletonTable rows={6} columns={4} />
          ) : report === null ? null : (
            <>
              {/* --- Headline figures ------------------------------------- */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {report.summary.map((entry) => (
                  <Card key={entry.key}>
                    <CardContent className="p-4 pt-4">
                      <p className="truncate text-xl leading-none font-semibold tabular-nums">
                        {formatValue(entry.value, entry.format)}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">{entry.label}</p>
                      {entry.hint && (
                        <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
                          {entry.hint}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {report.withheldTables.length > 0 && (
                <Alert tone="info">
                  <Lock className="size-4" aria-hidden /> Trend tables (
                  {report.withheldTables.join(', ')}) need the{' '}
                  <code className="font-mono text-xs">analytics.view</code> permission.
                </Alert>
              )}

              {/* --- Tables ------------------------------------------------ */}
              {report.tables.map((data) => (
                <Card key={data.id}>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                      {data.label}
                      <Badge tone="neutral" size="sm">
                        {data.totalRows}
                      </Badge>
                      {data.truncated && (
                        <Badge tone="warning" size="sm">
                          showing {data.rows.length}
                        </Badge>
                      )}
                    </CardTitle>

                    {selected?.canExport ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={exporting === data.id || data.rows.length === 0}
                        onClick={() => void download(data.id)}
                      >
                        <Download aria-hidden />
                        {exporting === data.id ? 'Preparing…' : 'CSV'}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <Lock className="size-3.5" aria-hidden />
                        needs {selected?.exportPermission}
                      </span>
                    )}
                  </CardHeader>

                  <CardContent>
                    {data.rows.length === 0 ? (
                      <EmptyState
                        variant="no-results"
                        icon={<FileSpreadsheet aria-hidden />}
                        title="Nothing in this period"
                        description="Widen the date range, or check that the activity was recorded."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              {data.columns.map((column) => (
                                <TableHead
                                  key={column.key}
                                  className={cn(isNumeric(column.format) && 'text-right')}
                                >
                                  {column.label}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.rows.map((row, index) => (
                              <TableRow key={index}>
                                {data.columns.map((column) => (
                                  <TableCell
                                    key={column.key}
                                    className={cn(
                                      isNumeric(column.format) && 'text-right tabular-nums',
                                    )}
                                  >
                                    {formatValue(row[column.key] ?? null, column.format)}
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function isNumeric(format: ValueFormat): boolean {
  return format === 'money' || format === 'number' || format === 'percent' || format === 'hours';
}

/** Minor units stay minor units all the way to here, and are divided once. */
function formatValue(value: string | number | boolean | null, format: ValueFormat): string {
  if (value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  switch (format) {
    case 'money':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'NGN',
        maximumFractionDigits: 0,
      }).format(Number(value) / 100);
    case 'percent':
      return `${Number(value).toFixed(1)}%`;
    case 'hours':
      return `${Number(value).toFixed(1)}h`;
    case 'number':
      return new Intl.NumberFormat().format(Number(value));
    case 'date':
      return new Date(String(value)).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: '2-digit',
      });
    case 'datetime':
      return new Date(String(value)).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    default:
      return String(value);
  }
}
