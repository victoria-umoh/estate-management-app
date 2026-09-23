import { Types } from 'mongoose';
import { BaseRepository, allocateReference } from '@/core/db';
import type { PaginatedResult } from '@/core/db';
import { AuthorizationError, ConflictError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { meService } from '@/modules/me';
import {
  ServiceRequestModel,
  type ServiceCategory,
  type ServicePriority,
  type ServiceRequestDoc,
  type ServiceStatus,
} from './schema';

const log = createLogger('service-request');

class ServiceRequestRepository extends BaseRepository<ServiceRequestDoc> {
  constructor() {
    super(ServiceRequestModel);
  }
}

export const serviceRequestRepository = new ServiceRequestRepository();

/**
 * Response targets, in hours.
 *
 * Applied at creation and then fixed on the row. Changing this table later must
 * not silently re-date tickets raised under the previous policy — an estate's
 * reported performance would otherwise shift retroactively.
 */
const SLA_HOURS: Record<ServicePriority, number> = {
  urgent: 4,
  high: 24,
  normal: 72,
  low: 168,
};

export interface CreateServiceRequestInput {
  category: ServiceCategory;
  priority?: ServicePriority;
  subject: string;
  description: string;
  location?: string;
  propertyId?: string;
  attachmentIds?: string[];
}

export class ServiceRequestService {
  async create(
    context: RequestContext,
    requesterMembershipId: string,
    input: CreateServiceRequestInput,
  ): Promise<ServiceRequestDoc> {
    assertCan(context, PERMISSIONS.SERVICE_REQUEST_CREATE);

    const priority = input.priority ?? 'normal';

    const request = await serviceRequestRepository.create(context, {
      ticketNumber: await allocateReference(
        ServiceRequestModel,
        'ticketNumber',
        'SR',
        context.estateId,
      ),
      category: input.category,
      priority,
      subject: input.subject.trim(),
      description: input.description.trim(),
      requestedByMembershipId: new Types.ObjectId(requesterMembershipId),
      ...(input.propertyId ? { propertyId: new Types.ObjectId(input.propertyId) } : {}),
      ...(input.location ? { location: input.location } : {}),
      attachmentIds: (input.attachmentIds ?? []).map((id) => new Types.ObjectId(id)),
      status: 'open',
      dueAt: new Date(Date.now() + SLA_HOURS[priority] * 3_600_000),
    });

    await auditService.record(context, {
      action: 'service_request.created',
      resource: 'service_request',
      resourceId: request._id,
      metadata: { ticketNumber: request.ticketNumber, category: input.category, priority },
    });

    return request;
  }

  async assign(
    context: RequestContext,
    requestId: string,
    input: { assigneeMembershipId?: string; department?: string },
  ): Promise<ServiceRequestDoc> {
    assertCan(context, PERMISSIONS.SERVICE_REQUEST_ASSIGN);

    const request = await serviceRequestRepository.findByIdOrFail(context, requestId);
    if (request.status === 'closed') {
      throw new ConflictError('That ticket is closed.');
    }

    const updated = await serviceRequestRepository.updateById(context, requestId, {
      $set: {
        status: 'assigned',
        ...(input.assigneeMembershipId
          ? { assignedToMembershipId: new Types.ObjectId(input.assigneeMembershipId) }
          : {}),
        ...(input.department ? { assignedDepartment: input.department } : {}),
        assignedAt: new Date(),
      },
    });

    await auditService.record(context, {
      action: 'service_request.assigned',
      resource: 'service_request',
      resourceId: requestId,
      metadata: { ticketNumber: request.ticketNumber, ...input },
    });

    return updated;
  }

  async setStatus(
    context: RequestContext,
    requestId: string,
    status: Extract<ServiceStatus, 'in-progress' | 'awaiting-resident'>,
  ): Promise<ServiceRequestDoc> {
    assertCan(context, PERMISSIONS.SERVICE_REQUEST_ASSIGN);

    const request = await serviceRequestRepository.findByIdOrFail(context, requestId);
    if (request.status === 'closed') throw new ConflictError('That ticket is closed.');

    return serviceRequestRepository.updateById(context, requestId, { $set: { status } });
  }

  async resolve(
    context: RequestContext,
    requestId: string,
    resolverMembershipId: string,
    resolution: string,
  ): Promise<ServiceRequestDoc> {
    assertCan(context, PERMISSIONS.SERVICE_REQUEST_RESOLVE);

    const request = await serviceRequestRepository.findByIdOrFail(context, requestId);
    if (request.status === 'resolved' || request.status === 'closed') {
      throw new ConflictError(`That ticket is already ${request.status}.`);
    }

    const updated = await serviceRequestRepository.updateById(context, requestId, {
      $set: {
        status: 'resolved',
        resolution: resolution.trim(),
        resolvedAt: new Date(),
        resolvedByMembershipId: new Types.ObjectId(resolverMembershipId),
      },
    });

    await auditService.record(context, {
      action: 'service_request.resolved',
      resource: 'service_request',
      resourceId: requestId,
      metadata: {
        ticketNumber: request.ticketNumber,
        // Recorded at resolution, since `dueAt` is fixed and this is the figure
        // the service report is built from.
        withinSla: Date.now() <= request.dueAt.getTime(),
      },
    });

    return updated;
  }

  /**
   * Close a ticket.
   *
   * Only the requester or staff may close, and only the requester may rate it.
   * A ticket closed by the person who did the work, with no resident
   * confirmation, is how "resolved" quietly diverges from "fixed".
   */
  async close(
    context: RequestContext,
    requestId: string,
    closerMembershipId: string,
    satisfactionRating?: number,
  ): Promise<ServiceRequestDoc> {
    const request = await serviceRequestRepository.findByIdOrFail(context, requestId);

    const isRequester = request.requestedByMembershipId.toHexString() === closerMembershipId;

    if (!isRequester && !can(context, PERMISSIONS.SERVICE_REQUEST_CLOSE)) {
      throw new AuthorizationError('You can only close tickets you raised.');
    }

    if (request.status === 'closed') throw new ConflictError('That ticket is already closed.');

    return serviceRequestRepository.updateById(context, requestId, {
      $set: {
        status: 'closed',
        closedAt: new Date(),
        // Only the person who asked for the work can judge whether it was done.
        ...(isRequester && satisfactionRating ? { satisfactionRating } : {}),
      },
    });
  }

  async list(
    context: RequestContext,
    filters: {
      status?: ServiceStatus;
      category?: ServiceCategory;
      priority?: ServicePriority;
      requestedByMembershipId?: string;
      overdue?: boolean;
    } = {},
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<ServiceRequestDoc>> {
    assertCan(context, PERMISSIONS.SERVICE_REQUEST_VIEW);

    // Residents hold the narrow permission to follow their own tickets; without
    // this the list returned every household's, subject line and all.
    const scope = await meService.narrowUnless(
      context,
      PERMISSIONS.SERVICE_REQUEST_VIEW_ALL,
      'requestedByMembershipId',
    );

    const filter: Record<string, unknown> = {};
    if (filters.status) filter.status = filters.status;
    if (filters.category) filter.category = filters.category;
    if (filters.priority) filter.priority = filters.priority;
    if (filters.requestedByMembershipId) {
      filter.requestedByMembershipId = new Types.ObjectId(filters.requestedByMembershipId);
    }
    if (filters.overdue) {
      filter.dueAt = { $lt: new Date() };
      filter.status = { $nin: ['resolved', 'closed'] };
    }

    return serviceRequestRepository.paginate(
      context,
      // Applied last, so a client-supplied `requestedByMembershipId` cannot
      // widen the scope back out.
      { ...filter, ...scope },
      pagination,
      { sort: { dueAt: 1 } },
    );
  }

  /**
   * Flag tickets past their response target.
   *
   * Runs across every estate as a scheduled sweep. Each ticket escalates once,
   * for the same reason overstay alerts fire once: a queue that re-notifies
   * every cycle is a queue people stop reading.
   */
  async escalateOverdue(): Promise<{ escalated: number }> {
    const overdue = await ServiceRequestModel.find({
      status: { $in: ['open', 'assigned', 'in-progress'] },
      dueAt: { $lt: new Date() },
      escalatedAt: null,
      deletedAt: null,
    })
      .limit(500)
      .lean<ServiceRequestDoc[]>()
      .exec();

    let escalated = 0;

    for (const request of overdue) {
      const context = systemContext(request.estateId.toHexString(), 'sla-sweep');

      try {
        await serviceRequestRepository.updateById(context, request._id, {
          $set: {
            escalatedAt: new Date(),
            priority: request.priority === 'low' ? 'normal' : 'high',
          },
        });

        await auditService.record(context, {
          action: 'service_request.escalated',
          resource: 'service_request',
          resourceId: request._id,
          metadata: {
            ticketNumber: request.ticketNumber,
            hoursOverdue: Math.floor((Date.now() - request.dueAt.getTime()) / 3_600_000),
          },
        });

        escalated += 1;
      } catch (error) {
        // One bad row must not stop the sweep: the remaining overdue tickets
        // are precisely the ones somebody needs to see.
        log.error(
          { err: error, requestId: request._id.toHexString() },
          'failed to escalate overdue ticket',
        );
      }
    }

    if (escalated > 0) log.info({ escalated }, 'overdue tickets escalated');

    return { escalated };
  }
}

export const serviceRequestService = new ServiceRequestService();
