import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { reportScheduleService } from '@/modules/report';

export const GET = defineRoute({
  permissions: [PERMISSIONS.REPORT_SCHEDULE],
  handler: async (ctx) => {
    const schedules = await reportScheduleService.list(ctx);

    return schedules.map((schedule) => ({
      id: schedule._id.toHexString(),
      reportType: schedule.reportType,
      tableId: schedule.tableId,
      cadence: schedule.cadence,
      dayOfWeek: schedule.dayOfWeek ?? null,
      dayOfMonth: schedule.dayOfMonth ?? null,
      hour: schedule.hour,
      recipients: schedule.recipients,
      active: schedule.active,
      lastRunAt: schedule.lastRunAt ?? null,
      lastRunStatus: schedule.lastRunStatus ?? null,
      lastRunDetail: schedule.lastRunDetail ?? null,
      nextRunAt: schedule.nextRunAt,
    }));
  },
});

/**
 * Schedule a report.
 *
 * The service refuses a report the caller could not export by hand — a
 * schedule performs the export on their behalf, so allowing it would be a way
 * to obtain one indirectly.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.REPORT_SCHEDULE],
  body: z.object({
    reportType: z.enum(['collections', 'gate-activity', 'residents', 'incidents', 'visitors']),
    tableId: z.string().trim().min(1).max(60),
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    // 28 so every month has one.
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    recipients: z.array(z.string().trim().email()).min(1).max(20),
  }),
  handler: async (ctx, { body }) => {
    const schedule = await reportScheduleService.create(ctx, body);

    return {
      id: schedule._id.toHexString(),
      reportType: schedule.reportType,
      cadence: schedule.cadence,
      nextRunAt: schedule.nextRunAt,
    };
  },
});
