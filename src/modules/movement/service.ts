import { Types } from 'mongoose';
import { BaseRepository } from '@/core/db';
import type { PaginatedResult } from '@/core/db';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { MovementModel, type MovementDoc } from './schema';

export interface RecordMovementInput {
  gateId: string;
  direction: MovementDoc['direction'];
  subject: MovementDoc['subject'];
  subjectId?: string;
  credentialId?: string;
  subjectLabel: string;
  unitNumber?: string | null;
  vehiclePlate?: string | null;
  admitted: boolean;
  denialReason?: string;
  method: MovementDoc['method'];
  partySize?: number;
  notes?: string;
  location?: { lat: number; lng: number };
  deviceInfo?: string;
}

/**
 * The gate log.
 *
 * Writes only — there is no update or delete path, and the schema rejects both.
 * Reads are for the security dashboard and for reports.
 */
class MovementRepository extends BaseRepository<MovementDoc> {
  constructor() {
    super(MovementModel);
  }

  /**
   * The most recent event for a subject, whichever way it went.
   *
   * Answers "is this vehicle inside right now?" without replaying the log:
   * an admitted `in` with nothing after it means it never left.
   */
  lastFor(
    context: RequestContext,
    subject: MovementDoc['subject'],
    subjectId: string,
  ): Promise<MovementDoc | null> {
    return this.findOne(
      context,
      { subject, subjectId: new Types.ObjectId(subjectId), admitted: true },
      { sort: { occurredAt: -1 } },
    );
  }

  /** How many events a gate has recorded since midnight. */
  countSince(context: RequestContext, gateId: string, since: Date): Promise<number> {
    return this.count(context, {
      gateId: new Types.ObjectId(gateId),
      occurredAt: { $gte: since },
    });
  }
}

/**
 * Exported so that services which must ask a question of the log — "is this
 * vehicle still inside?", "has this gate been used today?" — can do so without
 * holding `gateLog.view`, which is a permission about reading the log, not
 * about deleting a record that depends on it.
 */
export const movementRepository = new MovementRepository();
const repository = movementRepository;

export class MovementService {
  /**
   * Record a gate event.
   *
   * Called for denials as well as admissions. A refused scan is the more
   * interesting record: a pattern of them at 3am is the signal worth having,
   * and a log that only contains successes cannot show one.
   */
  async record(context: RequestContext, input: RecordMovementInput): Promise<MovementDoc> {
    return repository.create(context, {
      gateId: new Types.ObjectId(input.gateId),
      officerId: new Types.ObjectId(context.userId),
      direction: input.direction,
      subject: input.subject,
      ...(input.subjectId ? { subjectId: new Types.ObjectId(input.subjectId) } : {}),
      ...(input.credentialId ? { credentialId: new Types.ObjectId(input.credentialId) } : {}),
      // Copied, not referenced: the log must still say who passed through even
      // if the pass is later removed or the resident leaves.
      subjectLabel: input.subjectLabel,
      unitNumber: input.unitNumber ?? null,
      vehiclePlate: input.vehiclePlate ?? null,
      admitted: input.admitted,
      denialReason: input.denialReason ?? null,
      method: input.method,
      partySize: input.partySize ?? null,
      notes: input.notes ?? null,
      ...(input.location ? { location: input.location } : {}),
      deviceInfo: input.deviceInfo ?? null,
      occurredAt: new Date(),
    });
  }

  async recent(
    context: RequestContext,
    filters: {
      gateId?: string;
      direction?: MovementDoc['direction'];
      subject?: MovementDoc['subject'];
      admitted?: boolean;
      from?: Date;
      to?: Date;
    } = {},
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<MovementDoc>> {
    assertCan(context, PERMISSIONS.GATE_LOG_VIEW);

    const filter: Record<string, unknown> = {};
    if (filters.gateId) filter.gateId = new Types.ObjectId(filters.gateId);
    // Filtered in the query rather than by the caller: narrowing a page of
    // mixed entries and exits client-side thins the page instead of filling it.
    if (filters.direction) filter.direction = filters.direction;
    if (filters.subject) filter.subject = filters.subject;
    if (filters.admitted !== undefined) filter.admitted = filters.admitted;
    if (filters.from || filters.to) {
      filter.occurredAt = {
        ...(filters.from ? { $gte: filters.from } : {}),
        ...(filters.to ? { $lte: filters.to } : {}),
      };
    }

    return repository.paginate(context, filter, pagination, { sort: { occurredAt: -1 } });
  }

  /** Movement history for one subject, for an incident investigation. */
  async historyFor(
    context: RequestContext,
    subject: MovementDoc['subject'],
    subjectId: string,
    limit = 100,
  ): Promise<MovementDoc[]> {
    assertCan(context, PERMISSIONS.GATE_LOG_VIEW);

    const page = await repository.paginate(
      context,
      { subject, subjectId: new Types.ObjectId(subjectId) },
      { limit },
      { sort: { occurredAt: -1 } },
    );

    return page.items;
  }

  /** Counts for the security dashboard. */
  async todaySummary(context: RequestContext): Promise<{
    entries: number;
    exits: number;
    denied: number;
  }> {
    assertCan(context, PERMISSIONS.GATE_LOG_VIEW);

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const [entries, exits, denied] = await Promise.all([
      repository.count(context, { direction: 'in', admitted: true, occurredAt: { $gte: since } }),
      repository.count(context, { direction: 'out', admitted: true, occurredAt: { $gte: since } }),
      repository.count(context, { admitted: false, occurredAt: { $gte: since } }),
    ]);

    return { entries, exits, denied };
  }
}

export const movementService = new MovementService();
