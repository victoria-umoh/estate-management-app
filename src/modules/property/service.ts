import { Types } from 'mongoose';
import { withTransaction } from '@/core/db';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { propertyOccupancyRepository, propertyRepository } from './repository';
import type { OccupancyRole, PropertyDoc, PropertyOccupancyDoc } from './schema';

const log = createLogger('property');

export interface CreatePropertyInput {
  unitNumber: string;
  block?: string;
  street: string;
  type: PropertyDoc['type'];
  bedrooms?: number;
  maxOccupants?: number;
  notes?: string;
}

export interface AssignOccupantInput {
  propertyId: string;
  membershipId: string;
  role: OccupancyRole;
  leaseStartDate?: Date;
  leaseEndDate?: Date;
  occupantCount?: number;
}

export class PropertyService {
  async create(context: RequestContext, input: CreatePropertyInput): Promise<PropertyDoc> {
    assertCan(context, PERMISSIONS.PROPERTY_CREATE);

    const existing = await propertyRepository.findByUnitNumber(context, input.unitNumber);
    if (existing) {
      throw new ConflictError(`Unit ${input.unitNumber} already exists in this estate.`);
    }

    return withTransaction(async (session) => {
      const property = await propertyRepository.create(
        context,
        {
          unitNumber: input.unitNumber.trim(),
          ...(input.block ? { block: input.block.trim() } : {}),
          street: input.street.trim(),
          type: input.type,
          occupancyStatus: 'vacant',
          ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
          ...(input.maxOccupants !== undefined ? { maxOccupants: input.maxOccupants } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          currentOccupantCount: 0,
          registeredAt: new Date(),
        },
        { session },
      );

      await auditService.record(context, {
        action: 'property.created',
        resource: 'property',
        resourceId: property._id,
        after: { unitNumber: property.unitNumber, street: property.street, type: property.type },
        session,
      });

      return property;
    });
  }

  /**
   * Assign an owner, landlord or tenant.
   *
   * The whole operation is transactional: closing the previous holder's record,
   * opening the new one, and updating the property's occupancy status must
   * either all happen or none of them. A property showing as tenant-occupied
   * with no open tenancy row is a record nobody can reconcile.
   */
  async assignOccupant(
    context: RequestContext,
    input: AssignOccupantInput,
  ): Promise<PropertyOccupancyDoc> {
    assertCan(
      context,
      input.role === 'tenant' ? PERMISSIONS.TENANT_CREATE : PERMISSIONS.PROPERTY_UPDATE,
    );

    const property = await propertyRepository.findByIdOrFail(context, input.propertyId);

    if (input.leaseStartDate && input.leaseEndDate && input.leaseEndDate <= input.leaseStartDate) {
      throw new UnprocessableError('The lease end date must be after the start date.');
    }

    // Flagged rather than blocked: overcrowding is a matter for the estate to
    // handle, and refusing the record outright would simply push it off-system.
    if (
      input.occupantCount &&
      property.maxOccupants &&
      input.occupantCount > property.maxOccupants
    ) {
      log.warn(
        {
          propertyId: property._id.toHexString(),
          requested: input.occupantCount,
          max: property.maxOccupants,
        },
        'occupant count exceeds the registered maximum',
      );
    }

    return withTransaction(async (session) => {
      const current = await propertyOccupancyRepository.findCurrent(
        context,
        input.propertyId,
        input.role,
        { session },
      );

      if (current) {
        if (current.membershipId.toHexString() === input.membershipId) {
          throw new ConflictError(`That person is already the ${input.role} of this property.`);
        }

        // Closed, never deleted — invoices and gate logs from that period point
        // back to this row.
        await propertyOccupancyRepository.updateById(
          context,
          current._id,
          { $set: { endedAt: new Date(), endReason: 'transferred' } },
          { session },
        );
      }

      const occupancy = await propertyOccupancyRepository.create(
        context,
        {
          propertyId: new Types.ObjectId(input.propertyId),
          membershipId: new Types.ObjectId(input.membershipId),
          role: input.role,
          startedAt: new Date(),
          ...(input.leaseStartDate ? { leaseStartDate: input.leaseStartDate } : {}),
          ...(input.leaseEndDate ? { leaseEndDate: input.leaseEndDate } : {}),
          ...(input.occupantCount ? { occupantCount: input.occupantCount } : {}),
          recordedBy: new Types.ObjectId(context.userId),
        },
        { session },
      );

      await propertyRepository.updateById(
        context,
        input.propertyId,
        { $set: this.occupancyUpdateFor(input.role, input.membershipId, input.occupantCount) },
        { session },
      );

      await auditService.record(context, {
        action:
          input.role === 'tenant' ? 'property.tenant_assigned' : `property.${input.role}_assigned`,
        resource: 'property',
        resourceId: input.propertyId,
        metadata: {
          role: input.role,
          membershipId: input.membershipId,
          previousHolder: current?.membershipId.toHexString() ?? null,
        },
        session,
      });

      return occupancy;
    });
  }

  /** End a tenancy or ownership, preserving the record. */
  async endOccupancy(
    context: RequestContext,
    occupancyId: string,
    reason: NonNullable<PropertyOccupancyDoc['endReason']>,
  ): Promise<void> {
    const occupancy = await propertyOccupancyRepository.findByIdOrFail(context, occupancyId);

    assertCan(
      context,
      occupancy.role === 'tenant' ? PERMISSIONS.TENANT_EXIT : PERMISSIONS.PROPERTY_UPDATE,
    );

    if (occupancy.endedAt) {
      throw new ConflictError('That occupancy has already ended.');
    }

    await withTransaction(async (session) => {
      await propertyOccupancyRepository.updateById(
        context,
        occupancyId,
        { $set: { endedAt: new Date(), endReason: reason } },
        { session },
      );

      const remaining = await propertyOccupancyRepository.findCurrentOccupants(
        context,
        occupancy.propertyId,
      );
      const stillThere = remaining.filter((entry) => !entry._id.equals(occupancy._id));

      await propertyRepository.updateById(
        context,
        occupancy.propertyId,
        {
          $set: {
            occupancyStatus: this.deriveStatus(stillThere),
            ...(occupancy.role === 'owner' ? { ownerId: null } : {}),
            ...(occupancy.role === 'landlord' ? { landlordId: null } : {}),
            ...(occupancy.role === 'tenant' ? { currentOccupantCount: 0 } : {}),
          },
        },
        { session },
      );

      await auditService.record(context, {
        action: 'property.occupancy_ended',
        resource: 'property',
        resourceId: occupancy.propertyId.toHexString(),
        metadata: { role: occupancy.role, reason, occupancyId },
        session,
      });
    });
  }

  /**
   * Transfer ownership.
   *
   * Distinct from `assignOccupant` because a sale also ends any tenancy that
   * was in place under the previous owner: the new owner inherits the property,
   * not the previous owner's agreements.
   */
  async transferOwnership(
    context: RequestContext,
    input: { propertyId: string; toMembershipId: string; endExistingTenancies?: boolean },
  ): Promise<void> {
    assertCan(context, PERMISSIONS.PROPERTY_TRANSFER);

    const property = await propertyRepository.findByIdOrFail(context, input.propertyId);

    await withTransaction(async (session) => {
      const currentOwner = await propertyOccupancyRepository.findCurrent(
        context,
        input.propertyId,
        'owner',
        { session },
      );

      if (currentOwner) {
        await propertyOccupancyRepository.updateById(
          context,
          currentOwner._id,
          { $set: { endedAt: new Date(), endReason: 'transferred' } },
          { session },
        );
      }

      if (input.endExistingTenancies) {
        const tenancy = await propertyOccupancyRepository.findCurrent(
          context,
          input.propertyId,
          'tenant',
          { session },
        );
        if (tenancy) {
          await propertyOccupancyRepository.updateById(
            context,
            tenancy._id,
            { $set: { endedAt: new Date(), endReason: 'transferred' } },
            { session },
          );
        }
      }

      await propertyOccupancyRepository.create(
        context,
        {
          propertyId: new Types.ObjectId(input.propertyId),
          membershipId: new Types.ObjectId(input.toMembershipId),
          role: 'owner',
          startedAt: new Date(),
          recordedBy: new Types.ObjectId(context.userId),
        },
        { session },
      );

      await propertyRepository.updateById(
        context,
        input.propertyId,
        {
          $set: {
            ownerId: new Types.ObjectId(input.toMembershipId),
            ...(input.endExistingTenancies
              ? { occupancyStatus: 'vacant', currentOccupantCount: 0 }
              : {}),
          },
        },
        { session },
      );

      // Property transfer is one of the highest-consequence actions in the
      // system, so the trail records both parties explicitly.
      await auditService.record(context, {
        action: 'property.transferred',
        resource: 'property',
        resourceId: input.propertyId,
        metadata: {
          unitNumber: property.unitNumber,
          fromMembershipId: currentOwner?.membershipId.toHexString() ?? null,
          toMembershipId: input.toMembershipId,
          tenanciesEnded: input.endExistingTenancies ?? false,
        },
        session,
      });

      log.info(
        { propertyId: input.propertyId, to: input.toMembershipId },
        'property ownership transferred',
      );
    });
  }

  async history(context: RequestContext, propertyId: string): Promise<PropertyOccupancyDoc[]> {
    assertCan(context, PERMISSIONS.PROPERTY_VIEW);
    await propertyRepository.findByIdOrFail(context, propertyId);
    return propertyOccupancyRepository.findHistory(context, propertyId);
  }

  // ---------------------------------------------------------------------------

  private occupancyUpdateFor(
    role: OccupancyRole,
    membershipId: string,
    occupantCount?: number,
  ): Record<string, unknown> {
    switch (role) {
      case 'owner':
        return {
          ownerId: new Types.ObjectId(membershipId),
          occupancyStatus: 'owner-occupied',
        };
      case 'landlord':
        return { landlordId: new Types.ObjectId(membershipId) };
      case 'tenant':
        return {
          occupancyStatus: 'tenant-occupied',
          currentOccupantCount: occupantCount ?? 1,
        };
    }
  }

  private deriveStatus(occupants: PropertyOccupancyDoc[]): PropertyDoc['occupancyStatus'] {
    if (occupants.some((entry) => entry.role === 'tenant')) return 'tenant-occupied';
    if (occupants.some((entry) => entry.role === 'owner')) return 'owner-occupied';
    return 'vacant';
  }
}

export const propertyService = new PropertyService();
