import type { ReportCell, ReportColumn, ReportRow, ReportTable, ValueFormat } from './types';

/**
 * CSV writing.
 *
 * Aimed squarely at Excel, because that is where these files are opened. Three
 * things matter and all three are easy to get wrong:
 *
 *  - a UTF-8 BOM, without which Excel on Windows renders a resident's name as
 *    mojibake the moment it contains anything outside Latin-1;
 *  - CRLF line endings, which is what RFC 4180 specifies and what Excel's own
 *    exporter emits;
 *  - quoting, doubling any quote inside a quoted field.
 *
 * There is no XLSX or PDF here. `exceljs` and `pdfkit` are both installed, so
 * either is reachable later — see the module README notes in the service — but
 * a correct CSV beats a half-tested binary format for a file whose only job is
 * to open in a spreadsheet.
 */

const BOM = '﻿';
const CRLF = '\r\n';

/**
 * Cells Excel would evaluate as a formula.
 *
 * A resident whose notes field begins with `=` becomes a live formula in
 * whoever's spreadsheet opens this. Prefixing with an apostrophe makes Excel
 * treat it as text; the value is visibly unchanged in the cell.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeField(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;

  if (/["\r\n,]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  return guarded;
}

/** Render one cell for a spreadsheet, not for a human reading JSON. */
export function formatCell(value: ReportCell, format: ValueFormat): string {
  if (value === null || value === undefined) return '';

  switch (format) {
    case 'money':
      // Minor units in, major units out with two decimals, so the column sums
      // correctly in the spreadsheet rather than being off by a factor of 100.
      return (Number(value) / 100).toFixed(2);
    case 'percent':
      return Number(value).toFixed(1);
    case 'hours':
      return Number(value).toFixed(1);
    case 'number':
      return String(value);
    case 'date':
      return typeof value === 'string' ? value.slice(0, 10) : String(value);
    case 'datetime':
      return String(value);
    default:
      return typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  }
}

function headerLabel(column: ReportColumn): string {
  // The unit belongs in the header, not repeated down every row.
  if (column.format === 'money') return `${column.label} (NGN)`;
  if (column.format === 'percent') return `${column.label} (%)`;
  if (column.format === 'hours') return `${column.label} (hours)`;
  return column.label;
}

export interface CsvPreamble {
  /** Lines written above the header, each already human-readable. */
  notes: string[];
}

/**
 * Serialise one table.
 *
 * The preamble carries who ran it, over what range and whether it was capped.
 * That costs three rows at the top of the file and means a spreadsheet found in
 * an inbox six months later still says what it is — which is the whole reason
 * exports are audited in the first place.
 */
export function tableToCsv(table: ReportTable, preamble: CsvPreamble): string {
  const lines: string[] = [];

  for (const note of preamble.notes) {
    lines.push(escapeField(note));
  }
  if (preamble.notes.length > 0) lines.push('');

  lines.push(table.columns.map((column) => escapeField(headerLabel(column))).join(','));

  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((column) => escapeField(formatCell(row[column.key] ?? null, column.format)))
        .join(','),
    );
  }

  if (table.truncated) {
    lines.push('');
    lines.push(
      escapeField(
        `Truncated: ${table.rows.length} of ${table.totalRows} rows. Narrow the date range to see the rest.`,
      ),
    );
  }

  return BOM + lines.join(CRLF) + CRLF;
}

/** `collections-detail-2026-01-01-to-2026-03-31.csv` — sortable and self-describing. */
export function exportFilename(reportType: string, tableId: string, from: Date, to: Date): string {
  const day = (date: Date): string => date.toISOString().slice(0, 10);
  return `${reportType}-${tableId}-${day(from)}-to-${day(to)}.csv`;
}

export type { ReportRow };
