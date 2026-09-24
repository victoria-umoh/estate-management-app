import { Types } from 'mongoose';
import { BaseRepository } from '@/core/db';
import { UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { MAX_ATTACHMENT_BYTES } from '@/integrations/notifications';
import { auditService } from '@/modules/audit';
import { meService } from '@/modules/me';
import { MembershipModel } from '@/modules/membership/schema';
import { notificationService } from '@/modules/notification';
import { roleService } from '@/modules/role';
import { userRepository } from '@/modules/user/repository';
import { reportService } from './service';
import {
  ReportScheduleModel,
  type ReportScheduleDoc,
  type ScheduleCadence,
} from './schedule.schema';
import { REPORT_REGISTRY, type ReportType } from './types';

const log = createLogger('report:schedule');

class ReportScheduleRepository extends BaseRepository<ReportScheduleDoc> {
  constructor() {
    super(ReportScheduleModel);
  }
}

export const reportScheduleRepository = new ReportScheduleRepository();

export interface CreateScheduleInput {
  reportType: ReportType;
  tableId: string;
  cadence: ScheduleCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour?: number;
  recipients: string[];
}

/** The window a run covers: the period that just finished, not a rolling one. */
function rangeFor(cadence: ScheduleCadence, at: Date): { from: Date; to: Date } {
  const to = new Date(at);
  const from = new Date(at);

  if (cadence === 'daily') from.setDate(from.getDate() - 1);
  else if (cadence === 'weekly') from.setDate(from.getDate() - 7);
  else from.setMonth(from.getMonth() - 1);

  return { from, to };
}

function nextRunAfter(
  schedule: Pick<ReportScheduleDoc, 'cadence' | 'dayOfWeek' | 'dayOfMonth' | 'hour'>,
  after: Date,
): Date {
  const next = new Date(after);
  next.setMinutes(0, 0, 0);
  next.setHours(schedule.hour);

  if (schedule.cadence === 'daily') {
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }

  if (schedule.cadence === 'weekly') {
    const target = schedule.dayOfWeek ?? 1;
    // Always move at least one day forward, so a run completing at its own
    // scheduled hour does not immediately schedule itself again.
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getDay() !== target);
    return next;
  }

  next.setDate(schedule.dayOfMonth ?? 1);
  if (next <= after) next.setMonth(next.getMonth() + 1);
  return next;
}

export class ReportScheduleService {
  async list(context: RequestContext): Promise<ReportScheduleDoc[]> {
    assertCan(context, PERMISSIONS.REPORT_SCHEDULE);

    return reportScheduleRepository.findMany(context, {}, { sort: { nextRunAt: 1 } });
  }

  async create(context: RequestContext, input: CreateScheduleInput): Promise<ReportScheduleDoc> {
    assertCan(context, PERMISSIONS.REPORT_SCHEDULE);

    const descriptor = REPORT_REGISTRY[input.reportType];
    if (!descriptor) throw new UnprocessableError('That report does not exist.');

    // Scheduling a report you cannot run, or cannot export, would be a way to
    // obtain one indirectly — the schedule does the export on your behalf.
    for (const permission of [descriptor.viewPermission, descriptor.exportPermission]) {
      if (!can(context, permission)) {
        throw new UnprocessableError(
          `You cannot schedule a report you are not able to export yourself (missing "${permission}").`,
        );
      }
    }

    if (input.cadence === 'weekly' && input.dayOfWeek === undefined) {
      throw new UnprocessableError('A weekly schedule needs a day of the week.');
    }
    if (input.cadence === 'monthly' && input.dayOfMonth === undefined) {
      throw new UnprocessableError('A monthly schedule needs a day of the month.');
    }

    const membershipId = await meService.membershipId(context);
    const hour = input.hour ?? 7;

    const schedule = await reportScheduleRepository.create(context, {
      reportType: input.reportType,
      tableId: input.tableId,
      cadence: input.cadence,
      dayOfWeek: input.dayOfWeek ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      hour,
      recipients: input.recipients.map((address) => address.trim().toLowerCase()),
      ownerMembershipId: new Types.ObjectId(membershipId),
      ownerUserId: new Types.ObjectId(context.userId),
      active: true,
      nextRunAt: nextRunAfter(
        {
          ...input,
          hour,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
        },
        new Date(),
      ),
    });

    await auditService.record(context, {
      action: 'report.schedule_created',
      resource: 'report_schedule',
      resourceId: schedule._id.toHexString(),
      metadata: {
        reportType: input.reportType,
        tableId: input.tableId,
        cadence: input.cadence,
        recipientCount: input.recipients.length,
      },
    });

    return schedule;
  }

  async setActive(
    context: RequestContext,
    id: string,
    active: boolean,
  ): Promise<ReportScheduleDoc> {
    assertCan(context, PERMISSIONS.REPORT_SCHEDULE);

    const schedule = await reportScheduleRepository.updateById(context, id, { $set: { active } });

    await auditService.record(context, {
      action: active ? 'report.schedule_resumed' : 'report.schedule_paused',
      resource: 'report_schedule',
      resourceId: id,
    });

    return schedule;
  }

  async remove(context: RequestContext, id: string): Promise<void> {
    assertCan(context, PERMISSIONS.REPORT_SCHEDULE);

    await reportScheduleRepository.softDelete(context, id);

    await auditService.record(context, {
      action: 'report.schedule_deleted',
      resource: 'report_schedule',
      resourceId: id,
    });
  }

  /**
   * Run every schedule that has come due, across every estate.
   *
   * Each runs under a context carrying the **owner's** permissions, re-resolved
   * now rather than captured at creation. A schedule whose owner has since lost
   * the permission is skipped and recorded, not silently sent — a standing
   * instruction that outlives its author's authority is a slow data leak.
   */
  async runDue(
    now = new Date(),
  ): Promise<{ due: number; sent: number; skipped: number; failed: number }> {
    const due = await ReportScheduleModel.find({
      active: true,
      deletedAt: null,
      nextRunAt: { $lte: now },
    }).lean();

    const result = { due: due.length, sent: 0, skipped: 0, failed: 0 };

    for (const schedule of due) {
      const estateId = schedule.estateId.toHexString();
      let status: ReportScheduleDoc['lastRunStatus'] = 'failed';
      let detail = '';

      try {
        const context = await this.contextForOwner(schedule);

        if (!context) {
          status = 'skipped';
          detail = 'The owner no longer has permission to export this report.';
          result.skipped++;
        } else {
          const range = rangeFor(schedule.cadence, now);
          const exported = await reportService.export(context, schedule.reportType, range, {
            tableId: schedule.tableId,
          });

          const body = Buffer.from(exported.body, 'utf8');

          if (body.byteLength > MAX_ATTACHMENT_BYTES) {
            // Better to say so than to attempt a send the provider will reject,
            // leaving a schedule that appears to work and delivers nothing.
            status = 'skipped';
            detail = `The export is ${Math.round(body.byteLength / 1024)}kB, over the attachment limit. Narrow the report.`;
            result.skipped++;
          } else {
            await this.deliver(schedule, exported.filename, body, range, exported.rowCount);
            status = 'sent';
            detail = `${exported.rowCount} rows to ${schedule.recipients.length} recipient(s)`;
            result.sent++;
          }
        }
      } catch (error) {
        detail = error instanceof Error ? error.message.slice(0, 500) : 'Unknown failure.';
        result.failed++;
        log.error(
          { err: error, scheduleId: schedule._id.toHexString() },
          'scheduled report failed',
        );
      }

      // Advanced whatever happened. A schedule that failed once must not retry
      // on every sweep for the rest of the day.
      await ReportScheduleModel.updateOne(
        { _id: schedule._id },
        {
          $set: {
            lastRunAt: now,
            lastRunStatus: status,
            lastRunDetail: detail,
            nextRunAt: nextRunAfter(schedule, now),
          },
        },
      );

      await auditService.record(systemContext(estateId, 'report-schedule'), {
        action: 'report.scheduled_export',
        resource: 'report_schedule',
        resourceId: schedule._id.toHexString(),
        metadata: {
          reportType: schedule.reportType,
          tableId: schedule.tableId,
          status,
          detail,
          // The person who arranged this, not "system" — that is the fact worth
          // being able to reconstruct.
          ownerMembershipId: schedule.ownerMembershipId.toHexString(),
          recipients: schedule.recipients,
        },
      });
    }

    if (result.due > 0) log.info(result, 'scheduled reports complete');
    return result;
  }

  /**
   * A context carrying the owner's current permissions, or null if they no
   * longer hold what the report needs.
   */
  private async contextForOwner(schedule: ReportScheduleDoc): Promise<RequestContext | null> {
    const membership = await MembershipModel.findOne({
      _id: schedule.ownerMembershipId,
      status: 'active',
      deletedAt: null,
    }).lean();

    if (!membership) return null;

    const estateId = schedule.estateId.toHexString();
    const resolved = await roleService.resolvePermissions(schedule.estateId, membership.roleIds);

    const descriptor = REPORT_REGISTRY[schedule.reportType];
    const held = new Set<string>(resolved.permissions);

    const allowed = (permission: string) => held.has('*') || held.has(permission);
    if (
      !allowed(PERMISSIONS.REPORT_EXPORT) ||
      !allowed(descriptor.viewPermission) ||
      !allowed(descriptor.exportPermission)
    ) {
      return null;
    }

    return {
      userId: schedule.ownerUserId.toHexString(),
      estateId,
      roles: resolved.roles,
      permissions: held,
      correlationId: `schedule-${schedule._id.toHexString()}`,
      isPlatformAdmin: false,
    };
  }

  private async deliver(
    schedule: ReportScheduleDoc,
    filename: string,
    body: Buffer,
    range: { from: Date; to: Date },
    rowCount: number,
  ): Promise<void> {
    const descriptor = REPORT_REGISTRY[schedule.reportType];
    const owner = await userRepository.findById(schedule.ownerUserId);
    const period = `${range.from.toDateString()} to ${range.to.toDateString()}`;

    const ownerName = owner ? `${owner.firstName} ${owner.lastName}` : null;

    for (const recipient of schedule.recipients) {
      await notificationService.sendWithAttachment({
        to: recipient,
        templateId: 'report.scheduled',
        data: { reportTitle: descriptor.title, period, ownerName, rowCount },
        attachments: [{ filename, content: body, contentType: 'text/csv' }],
      });
    }
  }
}

export const reportScheduleService = new ReportScheduleService();
