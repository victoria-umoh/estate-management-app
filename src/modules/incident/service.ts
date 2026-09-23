import { Types } from 'mongoose';
import { BaseRepository, allocateReference, withTransaction } from '@/core/db';
import type { PaginatedResult } from '@/core/db';
import { events } from '@/core/events';
import { AuthorizationError, ConflictError, InvalidStateTransitionError, NotFoundError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { meService } from '@/modules/me';
import {
  IncidentCommentModel,
  IncidentModel,
  SEVERITY_RANK,
  type IncidentCategory,
  type IncidentCommentDoc,
  type IncidentDoc,
  type IncidentSeverity,
  type IncidentStatus,
} from './schema';

const log = createLogger('incident');

class IncidentRepository extends BaseRepository<IncidentDoc> {
  constructor() {
    super(IncidentModel);
  }
}

class IncidentCommentRepository extends BaseRepository<IncidentCommentDoc> {
  constructor() {
    super(IncidentCommentModel);
  }
}

export const incidentRepository = new IncidentRepository();
export const incidentCommentRepository = new IncidentCommentRepository();

/**
 * Permitted status moves.
 *
 * Declared as data rather than scattered through conditionals, so the whole
 * lifecycle is readable in one place and an invalid move produces a clear error
 * naming both ends rather than a silent no-op.
 */
const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['assigned', 'investigating', 'resolved', 'escalated', 'closed'],
  assigned: ['investigating', 'resolved', 'escalated', 'open'],
  investigating: ['resolved', 'escalated', 'assigned'],
  escalated: ['investigating', 'resolved', 'assigned'],
  resolved: ['closed', 'investigating'],
  // Terminal. Reopening means raising a new incident that references this one,
  // so the original's timeline stays intact.
  closed: [],
};

export interface ReportIncidentInput {
  category: IncidentCategory;
  severity?: IncidentSeverity;
  title: string;
  description: string;
  occurredAt?: Date;
  location?: string;
  coordinates?: { lat: number; lng: number };
  gateId?: string;
  propertyId?: string;
  involvedPersons?: Array<{ label: string; membershipId?: string }>;
  involvedVehicles?: Array<{ plate: string; vehicleId?: string }>;
  attachmentIds?: string[];
}

export class IncidentService {
  async report(
    context: RequestContext,
    reporterMembershipId: string,
    input: ReportIncidentInput,
  ): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_CREATE);

    const incident = await incidentRepository.create(context, {
      reference: await allocateReference(IncidentModel, 'reference', 'INC', context.estateId),
      category: input.category,
      severity: input.severity ?? 'medium',
      severityRank: SEVERITY_RANK[input.severity ?? 'medium'],
      title: input.title.trim(),
      description: input.description.trim(),
      reportedByMembershipId: new Types.ObjectId(reporterMembershipId),
      occurredAt: input.occurredAt ?? new Date(),
      ...(input.location ? { location: input.location } : {}),
      ...(input.coordinates ? { coordinates: input.coordinates } : {}),
      ...(input.gateId ? { gateId: new Types.ObjectId(input.gateId) } : {}),
      ...(input.propertyId ? { propertyId: new Types.ObjectId(input.propertyId) } : {}),
      involvedPersons: (input.involvedPersons ?? []).map((person) => ({
        label: person.label,
        membershipId: person.membershipId ? new Types.ObjectId(person.membershipId) : null,
      })),
      involvedVehicles: (input.involvedVehicles ?? []).map((vehicle) => ({
        plate: vehicle.plate.toUpperCase(),
        vehicleId: vehicle.vehicleId ? new Types.ObjectId(vehicle.vehicleId) : null,
      })),
      attachmentIds: (input.attachmentIds ?? []).map((id) => new Types.ObjectId(id)),
      status: 'open',
    });

    await auditService.record(context, {
      action: 'incident.created',
      resource: 'incident',
      resourceId: incident._id,
      metadata: {
        reference: incident.reference,
        category: incident.category,
        severity: incident.severity,
      },
    });

    events.emit('incident.created', {
      incidentId: incident._id.toHexString(),
      estateId: context.estateId,
      severity: incident.severity,
    });

    if (incident.severity === 'critical') {
      log.error(
        { incidentId: incident._id.toHexString(), reference: incident.reference },
        'critical incident reported',
      );
    }

    return incident;
  }

  async assign(
    context: RequestContext,
    incidentId: string,
    assigneeMembershipId: string,
  ): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_ASSIGN);

    const incident = await incidentRepository.findByIdOrFail(context, incidentId);
    this.assertTransition(incident.status, 'assigned');

    const updated = await incidentRepository.updateById(context, incidentId, {
      $set: {
        status: 'assigned',
        assignedToMembershipId: new Types.ObjectId(assigneeMembershipId),
        assignedAt: new Date(),
      },
    });

    await auditService.record(context, {
      action: 'incident.assigned',
      resource: 'incident',
      resourceId: incidentId,
      metadata: { reference: incident.reference, assigneeMembershipId },
    });

    return updated;
  }

  async setStatus(
    context: RequestContext,
    incidentId: string,
    status: Extract<IncidentStatus, 'investigating' | 'open'>,
  ): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_UPDATE);

    const incident = await incidentRepository.findByIdOrFail(context, incidentId);
    this.assertTransition(incident.status, status);

    return incidentRepository.updateById(context, incidentId, { $set: { status } });
  }

  async resolve(
    context: RequestContext,
    incidentId: string,
    resolverMembershipId: string,
    resolution: string,
  ): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_RESOLVE);

    const incident = await incidentRepository.findByIdOrFail(context, incidentId);
    this.assertTransition(incident.status, 'resolved');

    const updated = await incidentRepository.updateById(context, incidentId, {
      $set: {
        status: 'resolved',
        resolution: resolution.trim(),
        resolvedAt: new Date(),
        resolvedByMembershipId: new Types.ObjectId(resolverMembershipId),
      },
    });

    await auditService.record(context, {
      action: 'incident.resolved',
      resource: 'incident',
      resourceId: incidentId,
      before: { status: incident.status },
      after: { status: 'resolved' },
    });

    events.emit('incident.resolved', {
      incidentId,
      estateId: context.estateId,
    });

    return updated;
  }

  /**
   * Close an incident.
   *
   * Terminal: reopening means raising a new incident that references this one,
   * so the original's timeline stays intact and a dispute cannot be answered
   * with a record that was edited after the fact.
   */
  async close(context: RequestContext, incidentId: string): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_CLOSE);

    const incident = await incidentRepository.findByIdOrFail(context, incidentId);
    this.assertTransition(incident.status, 'closed');

    const updated = await incidentRepository.updateById(context, incidentId, {
      $set: { status: 'closed', closedAt: new Date() },
    });

    await auditService.record(context, {
      action: 'incident.closed',
      resource: 'incident',
      resourceId: incidentId,
      metadata: { reference: incident.reference },
    });

    return updated;
  }

  async escalate(
    context: RequestContext,
    incidentId: string,
    reason: string,
  ): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_ESCALATE);

    const incident = await incidentRepository.findByIdOrFail(context, incidentId);
    this.assertTransition(incident.status, 'escalated');

    const updated = await incidentRepository.updateById(context, incidentId, {
      $set: {
        status: 'escalated',
        escalatedAt: new Date(),
        escalationReason: reason.trim(),
        // Escalation implies the current severity was understated.
        ...(incident.severity === 'low' || incident.severity === 'medium'
          ? { severity: 'high', severityRank: SEVERITY_RANK.high }
          : {}),
      },
    });

    await auditService.record(context, {
      action: 'incident.escalated',
      resource: 'incident',
      resourceId: incidentId,
      metadata: { reference: incident.reference, reason },
    });

    log.warn({ incidentId, reference: incident.reference }, 'incident escalated');

    return updated;
  }

  async comment(
    context: RequestContext,
    incidentId: string,
    authorMembershipId: string,
    body: string,
    options: { internal?: boolean; attachmentIds?: string[] } = {},
  ): Promise<IncidentCommentDoc> {
    const incident = await incidentRepository.findByIdOrFail(context, incidentId);

    // A resident may comment on their own report; staff may comment on any.
    const isReporter = incident.reportedByMembershipId.toHexString() === authorMembershipId;
    if (!isReporter && !can(context, PERMISSIONS.INCIDENT_UPDATE)) {
      throw new AuthorizationError('You can only comment on incidents you reported.');
    }

    // Internal notes are for staff. A resident marking their own comment
    // internal would hide it from the very people handling the case.
    const internal = options.internal === true && can(context, PERMISSIONS.INCIDENT_UPDATE);

    return withTransaction(async (session) =>
      incidentCommentRepository.create(
        context,
        {
          incidentId: new Types.ObjectId(incidentId),
          authorMembershipId: new Types.ObjectId(authorMembershipId),
          body: body.trim(),
          internal,
          attachmentIds: (options.attachmentIds ?? []).map((id) => new Types.ObjectId(id)),
        },
        { session },
      ),
    );
  }

  /** Comments on an incident, hiding internal notes from residents. */
  async comments(
    context: RequestContext,
    incidentId: string,
    viewerMembershipId: string,
  ): Promise<IncidentCommentDoc[]> {
    const incident = await incidentRepository.findByIdOrFail(context, incidentId);

    const isStaff = can(context, PERMISSIONS.INCIDENT_UPDATE);
    if (!isStaff && incident.reportedByMembershipId.toHexString() !== viewerMembershipId) {
      throw new AuthorizationError('You can only view incidents you reported.');
    }

    return incidentCommentRepository.findMany(
      context,
      { incidentId: new Types.ObjectId(incidentId), ...(isStaff ? {} : { internal: false }) },
      { sort: { createdAt: 1 } },
    );
  }

  async list(
    context: RequestContext,
    filters: {
      status?: IncidentStatus;
      category?: IncidentCategory;
      severity?: IncidentSeverity;
      assignedToMembershipId?: string;
      reportedByMembershipId?: string;
    } = {},
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<IncidentDoc>> {
    assertCan(context, PERMISSIONS.INCIDENT_VIEW);

    const filter: Record<string, unknown> = {};

    // Without the estate-wide permission the caller sees only what they
    // reported or were named in. Narrowing here rather than refusing means a
    // resident can still follow their own report, which is the whole reason
    // they hold `incident.view`.
    if (!can(context, PERMISSIONS.INCIDENT_VIEW_ALL)) {
      const membershipId = await meService.membershipId(context);
      filter.$or = [
        { reportedByMembershipId: new Types.ObjectId(membershipId) },
        { 'involvedPersons.membershipId': new Types.ObjectId(membershipId) },
      ];
    }
    if (filters.status) filter.status = filters.status;
    if (filters.category) filter.category = filters.category;
    if (filters.severity) filter.severity = filters.severity;
    if (filters.assignedToMembershipId) {
      filter.assignedToMembershipId = new Types.ObjectId(filters.assignedToMembershipId);
    }
    if (filters.reportedByMembershipId) {
      filter.reportedByMembershipId = new Types.ObjectId(filters.reportedByMembershipId);
    }

    return incidentRepository.paginate(context, filter, pagination, {
      // Severity first, by rank rather than by the string — alphabetical order
      // would put "low" above "critical". A critical incident must not be
      // pushed down the list by a newer noise complaint.
      sort: { severityRank: -1, createdAt: -1 },
    });
  }

  /**
   * One incident, if the caller may see it.
   *
   * A resident may read an incident they reported or were named in; anyone
   * else needs the estate-wide permission. The refusal is a 404 rather than a
   * 403, because confirming an incident exists but is none of your business
   * still tells you it happened.
   */
  async detailFor(context: RequestContext, incidentId: string): Promise<IncidentDoc> {
    assertCan(context, PERMISSIONS.INCIDENT_VIEW);

    const incident = await incidentRepository.findByIdOrFail(context, incidentId);
    if (can(context, PERMISSIONS.INCIDENT_VIEW_ALL)) return incident;

    const membershipId = new Types.ObjectId(await meService.membershipId(context));
    const involved =
      incident.reportedByMembershipId.equals(membershipId) ||
      incident.involvedPersons.some((person) => person.membershipId?.equals(membershipId));

    if (!involved) throw new NotFoundError('Incident');
    return incident;
  }

  private assertTransition(from: IncidentStatus, to: IncidentStatus): void {
    if (from === to) throw new ConflictError(`That incident is already ${to}.`);
    if (!TRANSITIONS[from].includes(to)) throw new InvalidStateTransitionError(from, to);
  }
}

export const incidentService = new IncidentService();
