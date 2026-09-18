import { Types } from 'mongoose';
import { NotFoundError } from '@/core/errors';
import type { PaginatedResult } from '@/core/db';
import { assertCan, PERMISSIONS } from '@/core/rbac';
import { assertTenantContext, type RequestContext } from '@/core/tenancy';
import { AuditLogModel, type AuditLogDoc } from './schema';

export interface AuditQuery {
  action?: string;
  resource?: string;
  resourceId?: string;
  actorId?: string;
  outcome?: 'success' | 'failure';
  from?: Date;
  to?: Date;
}

/**
 * Read access to the audit trail.
 *
 * Deliberately NOT a BaseRepository subclass: that base exposes create, update
 * and delete, and the audit log must offer none of them. Tenant scoping is
 * applied here by the same rule, and every read requires `audit.view`.
 */
export class AuditRepository {
  async search(
    context: RequestContext,
    query: AuditQuery = {},
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<AuditLogDoc>> {
    assertTenantContext(context);
    assertCan(context, PERMISSIONS.AUDIT_VIEW);

    const page = Math.max(1, Math.floor(pagination.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(pagination.limit ?? 25)));

    const filter: Record<string, unknown> = {
      estateId: new Types.ObjectId(context.estateId),
    };

    if (query.action) filter.action = query.action;
    if (query.resource) filter.resource = query.resource;
    if (query.resourceId) filter.resourceId = query.resourceId;
    if (query.outcome) filter.outcome = query.outcome;
    if (query.actorId && Types.ObjectId.isValid(query.actorId)) {
      filter.actorId = new Types.ObjectId(query.actorId);
    }
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }

    const [items, total] = await Promise.all([
      AuditLogModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<AuditLogDoc[]>()
        .exec(),
      AuditLogModel.countDocuments(filter).exec(),
    ]);

    const totalPages = Math.ceil(total / limit);
    return { items, total, page, limit, totalPages, hasNextPage: page < totalPages };
  }

  /** The full history of one record, oldest first. */
  async historyFor(
    context: RequestContext,
    resource: string,
    resourceId: string,
  ): Promise<AuditLogDoc[]> {
    assertTenantContext(context);
    assertCan(context, PERMISSIONS.AUDIT_VIEW);

    return AuditLogModel.find({
      estateId: new Types.ObjectId(context.estateId),
      resource,
      resourceId,
    })
      .sort({ createdAt: 1 })
      .lean<AuditLogDoc[]>()
      .exec();
  }

  async findById(context: RequestContext, id: string): Promise<AuditLogDoc> {
    assertTenantContext(context);
    assertCan(context, PERMISSIONS.AUDIT_VIEW);

    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Audit entry');

    const entry = await AuditLogModel.findOne({
      _id: new Types.ObjectId(id),
      estateId: new Types.ObjectId(context.estateId),
    })
      .lean<AuditLogDoc>()
      .exec();

    if (!entry) throw new NotFoundError('Audit entry');
    return entry;
  }
}

export const auditRepository = new AuditRepository();
