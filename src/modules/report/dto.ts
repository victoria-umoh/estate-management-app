import { z } from 'zod';
import { REPORT_TYPES, type ReportType } from './types';

/**
 * Request shapes for the report routes.
 *
 * Kept in the module rather than in a route file because the run and export
 * routes share them, and a Next route module may only export handlers.
 */
export const ReportTypeParam = z.object({
  type: z.enum(REPORT_TYPES as unknown as [ReportType, ...ReportType[]]),
});

export const ReportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Narrow to one table, for a screen that renders them one at a time. */
  table: z.string().trim().max(40).optional(),
});

export const ReportExportQuery = ReportQuery.extend({
  table: z.string().trim().max(40).default('detail'),
  format: z.enum(['csv']).default('csv'),
});

/**
 * Thirty days when nothing is asked for.
 *
 * A report with no range would otherwise scan every movement the estate has
 * ever recorded, which is both slow and almost never what the person clicking
 * wanted.
 */
const DEFAULT_DAYS = 30;

export function resolveRange(input: { from?: Date; to?: Date }): { from: Date; to: Date } {
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - DEFAULT_DAYS * 24 * 3_600_000);
  return { from, to };
}
