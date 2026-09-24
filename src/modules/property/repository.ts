import { Types, type ClientSession } from 'mongoose';
import { BaseRepository } from '@/core/db';
import type { RequestContext } from '@/core/tenancy';
import {
  PropertyModel,
  PropertyOccupancyModel,
  type OccupancyRole,
  type PropertyDoc,
  type PropertyOccupancyDoc,
} from './schema';

export class PropertyRepository extends BaseRepository<PropertyDoc> {
  constructor() {
    super(PropertyModel);
  }

  findByUnitNumber(context: RequestContext, unitNumber: string): Promise<PropertyDoc | null> {
    return this.findOne(context, { unitNumber: unitNumber.trim() });
  }
}

export class PropertyOccupancyRepository extends BaseRepository<PropertyOccupancyDoc> {
  constructor() {
    super(PropertyOccupancyModel);
  }

  /** The current holder of a role, or null when the position is open. */
  findCurrent(
    context: RequestContext,
    propertyId: string | Types.ObjectId,
    role: OccupancyRole,
    options: { session?: ClientSession } = {},
  ): Promise<PropertyOccupancyDoc | null> {
    return this.findOne(
      context,
      { propertyId: new Types.ObjectId(propertyId), role, endedAt: null },
      options,
    );
  }

  /** Everyone currently in a property, across all roles. */
  findCurrentOccupants(
    context: RequestContext,
    propertyId: string | Types.ObjectId,
  ): Promise<PropertyOccupancyDoc[]> {
    return this.findMany(context, { propertyId: new Types.ObjectId(propertyId), endedAt: null });
  }

  /**
   * Full history for a property, newest first.
   *
   * Includes ended records by design: the point of this collection is that it
   * outlives the relationships it describes.
   */
  findHistory(
    context: RequestContext,
    propertyId: string | Types.ObjectId,
  ): Promise<PropertyOccupancyDoc[]> {
    return this.findMany(
      context,
      { propertyId: new Types.ObjectId(propertyId) },
      { sort: { startedAt: -1 } },
    );
  }

  /** Every property a membership currently holds or occupies. */
  findForMembership(
    context: RequestContext,
    membershipId: string | Types.ObjectId,
  ): Promise<PropertyOccupancyDoc[]> {
    return this.findMany(context, {
      membershipId: new Types.ObjectId(membershipId),
      endedAt: null,
    });
  }

  /**
   * Tenancies, newest first.
   *
   * Separate from `findHistory` because it spans the estate rather than one
   * property: the screen this backs is "every tenancy", filtered by where each
   * one has got to in its lifecycle.
   */
  paginateTenancies(
    context: RequestContext,
    filters: {
      propertyId?: string;
      membershipId?: string;
      /** `pending` and `approved` are about sign-off; `ended` is about time. */
      state?: 'pending' | 'approved' | 'active' | 'ended';
    } = {},
    pagination: { page?: number; limit?: number } = {},
  ) {
    const filter: Record<string, unknown> = { role: 'tenant' };

    if (filters.propertyId) filter.propertyId = new Types.ObjectId(filters.propertyId);
    if (filters.membershipId) filter.membershipId = new Types.ObjectId(filters.membershipId);

    switch (filters.state) {
      case 'pending':
        filter.approvedAt = null;
        filter.endedAt = null;
        break;
      case 'approved':
      case 'active':
        filter.approvedAt = { $ne: null };
        filter.endedAt = null;
        break;
      case 'ended':
        filter.endedAt = { $ne: null };
        break;
      default:
        break;
    }

    return this.paginate(context, filter, pagination, { sort: { startedAt: -1 } });
  }

  /** Tenancies expiring within the window, for renewal reminders. */
  findExpiringLeases(context: RequestContext, withinDays: number): Promise<PropertyOccupancyDoc[]> {
    const cutoff = new Date(Date.now() + withinDays * 86_400_000);

    return this.findMany(context, {
      role: 'tenant',
      endedAt: null,
      leaseEndDate: { $ne: null, $lte: cutoff },
    });
  }
}

export const propertyRepository = new PropertyRepository();
export const propertyOccupancyRepository = new PropertyOccupancyRepository();
