import { PERMISSIONS, type Permission } from '@/core/rbac';

/**
 * Report shapes.
 *
 * Every report answers with the same envelope — summary figures, then one or
 * more tables — so the screen, the CSV writer and any future format handle one
 * shape rather than five. What differs between reports is which tables exist
 * and what the columns mean, and that is data here rather than branching later.
 */

export type ReportType = 'collections' | 'gate-activity' | 'residents' | 'incidents' | 'visitors';

export const REPORT_TYPES = [
  'collections',
  'gate-activity',
  'residents',
  'incidents',
  'visitors',
] as const;

/** How a value should be rendered. The number itself stays a number. */
export type ValueFormat = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'hours';

export interface ReportColumn {
  key: string;
  label: string;
  format: ValueFormat;
}

export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportStat {
  key: string;
  label: string;
  value: number | string | null;
  format: ValueFormat;
  /** One line saying what the figure means when it is not self-evident. */
  hint?: string;
}

export interface ReportTable {
  id: string;
  label: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Rows the query matched, before any cap was applied. */
  totalRows: number;
  /** True when `rows` is shorter than `totalRows` because of the cap. */
  truncated: boolean;
}

export interface ReportResult {
  type: ReportType;
  title: string;
  description: string;
  range: { from: string; to: string };
  generatedAt: string;
  summary: ReportStat[];
  tables: ReportTable[];
  /**
   * Tables the caller was not shown because they lack `analytics.view`.
   * Named rather than silently dropped, so a manager can be told what to ask
   * for instead of wondering why the trend is missing.
   */
  withheldTables: string[];
  /** True when the caller may export this report. Drives the UI, not the gate. */
  exportable: boolean;
}

export interface ReportDescriptor {
  type: ReportType;
  title: string;
  description: string;
  /** Permission required to read it, beyond `report.generate`. */
  viewPermission: Permission;
  /** Permission required to take it out of the system, beyond `report.export`. */
  exportPermission: Permission;
}

/**
 * The registry.
 *
 * View and export are deliberately separate permissions on every row. Reading
 * a collections figure on screen and carrying the whole receivables ledger out
 * as a file that will be forwarded, archived and eventually mislaid are not the
 * same act, and the estate's own role definitions already treat them that way —
 * an estate manager holds `gateLog.view` and not `gateLog.export`.
 *
 * Where no resource-specific export permission exists (incidents, visitors),
 * the generic `report.export` stands in rather than a new permission being
 * invented: the permission names are a stored contract, and adding one means
 * every existing role silently lacks it.
 */
export const REPORT_REGISTRY: Record<ReportType, ReportDescriptor> = {
  collections: {
    type: 'collections',
    title: 'Collections',
    description:
      'What was invoiced, what was collected and what is still outstanding, by fee category and by month.',
    viewPermission: PERMISSIONS.LEDGER_VIEW,
    exportPermission: PERMISSIONS.LEDGER_EXPORT,
  },
  'gate-activity': {
    type: 'gate-activity',
    title: 'Gate activity',
    description:
      'Entries and exits by day and by gate, admitted against denied, and the hours the gate is busiest.',
    viewPermission: PERMISSIONS.GATE_LOG_VIEW,
    exportPermission: PERMISSIONS.GATE_LOG_EXPORT,
  },
  residents: {
    type: 'residents',
    title: 'Residents',
    description:
      'Headcount by category and status, with move-ins and move-outs over the period. Contact details and identity numbers are deliberately excluded.',
    viewPermission: PERMISSIONS.RESIDENT_VIEW,
    exportPermission: PERMISSIONS.RESIDENT_EXPORT,
  },
  incidents: {
    type: 'incidents',
    title: 'Incidents & safety',
    description:
      'Counts by category and severity, mean time to resolve, and resolutions that missed their severity target.',
    viewPermission: PERMISSIONS.INCIDENT_VIEW_ALL,
    exportPermission: PERMISSIONS.REPORT_EXPORT,
  },
  visitors: {
    type: 'visitors',
    title: 'Visitors',
    description: 'Visit volume, overstay rate and the households receiving the most visitors.',
    viewPermission: PERMISSIONS.VISITOR_VIEW,
    exportPermission: PERMISSIONS.REPORT_EXPORT,
  },
};

/**
 * Resolution targets used to count SLA breaches on the incidents report.
 *
 * Declared here, and only here: incidents carry no `dueAt` the way service
 * requests do, so this is a reporting convention rather than something the
 * incident workflow enforces. Stating the numbers in the module that applies
 * them is better than a figure nobody can account for.
 */
export const INCIDENT_SLA_HOURS: Record<string, number> = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168,
};

/**
 * Rows returned inline with a report.
 *
 * Small on purpose: the JSON body is rendered into a table on a phone, and a
 * ten-thousand-row payload helps nobody. The export path has its own, larger
 * cap.
 */
export const PREVIEW_ROW_LIMIT = 200;

/**
 * Hard ceiling on an exported table.
 *
 * A year of a busy estate's movement log is hundreds of thousands of rows;
 * building that in memory as one string is how the process dies. The cap is
 * enforced in the query, reported in the response headers and stated on the
 * last line of the file, so a truncated export is never mistaken for a
 * complete one.
 */
export const EXPORT_ROW_LIMIT = 10_000;

export type ExportFormat = 'csv';
