import { Types, type ClientSession } from 'mongoose';
import { createLogger } from '@/core/logging';
import type { RequestContext } from '@/core/tenancy';
import { diffRecords, redactMetadata, type FieldChange } from './diff';
import { AuditLogModel, type AuditLogDoc, type AuditOutcome } from './schema';

const log = createLogger('audit');

export interface AuditEntryInput {
  action: string;
  resource: string;
  resourceId?: string | Types.ObjectId | null;
  outcome?: AuditOutcome;
  reason?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changes?: FieldChange[];
  metadata?: Record<string, unknown>;
  location?: { lat: number; lng: number };
  /**
   * Write inside the caller's transaction, so the record and its audit entry
   * commit or roll back together. A state change with no trail, or a trail
   * describing a change that was rolled back, are both worse than neither.
   */
  session?: ClientSession;
}

export class AuditService {
  /**
   * Record an action.
   *
   * When a session is supplied the write joins that transaction and a failure
   * propagates, because losing the trail for a committed change is not
   * acceptable. Outside a transaction, failures are logged and swallowed: an
   * audit outage must not take the whole application down with it.
   */
  async record(context: RequestContext, input: AuditEntryInput): Promise<void> {
    const changes =
      input.changes ??
      (input.before || input.after ? diffRecords(input.before, input.after) : undefined);

    const entry: Partial<AuditLogDoc> = {
      estateId: context.estateId ? new Types.ObjectId(context.estateId) : null,
      actorId: Types.ObjectId.isValid(context.userId) ? new Types.ObjectId(context.userId) : null,
      actorLabel: context.userId,
      actorRoles: [...context.roles],
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ? String(input.resourceId) : null,
      outcome: input.outcome ?? 'success',
      reason: input.reason ?? null,
      ...(changes && changes.length > 0 ? { changes } : {}),
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      correlationId: context.correlationId ?? null,
      ...(input.location ? { location: input.location } : {}),
      ...(input.metadata ? { metadata: redactMetadata(input.metadata) } : {}),
    };

    try {
      await AuditLogModel.create([entry], { session: input.session });
    } catch (error) {
      if (input.session) throw error;

      log.error({ err: error, action: input.action }, 'failed to write audit entry');
    }
  }

  /** Record a refused attempt. Repeated failures are the probing signal. */
  async recordFailure(
    context: RequestContext,
    input: Omit<AuditEntryInput, 'outcome'> & { reason: string },
  ): Promise<void> {
    await this.record(context, { ...input, outcome: 'failure' });
  }
}

export const auditService = new AuditService();
