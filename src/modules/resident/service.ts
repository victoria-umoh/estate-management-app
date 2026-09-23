import { Types } from 'mongoose';
import type { PaginatedResult } from '@/core/db';
import { decryptField } from '@/core/crypto';
import { NotFoundError } from '@/core/errors';
import { events } from '@/core/events';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { membershipRepository } from '@/modules/membership/repository';
import { MembershipModel, type MembershipDoc } from '@/modules/membership/schema';
import { propertyOccupancyRepository, propertyRepository } from '@/modules/property';
import { userRepository } from '@/modules/user/repository';
import { UserModel, type UserDoc } from '@/modules/user/schema';
import type { GateIdentity, ResidentDetail, ResidentListItem } from './types';

export interface ResidentQuery {
  category?: MembershipDoc['category'];
  status?: MembershipDoc['status'];
  propertyId?: string;
  /** Matches name, resident code or unit number. */
  search?: string;
}

/**
 * The resident directory.
 *
 * Reads span two collections — `memberships` (tenant-scoped) and `users`
 * (global) — so every query starts from memberships, which carry the tenant
 * guard, and only then resolves the user records those memberships name. The
 * reverse order would mean searching a global collection and filtering
 * afterwards, which is one forgotten filter away from a cross-estate leak.
 */
export class ResidentService {
  async list(
    context: RequestContext,
    query: ResidentQuery = {},
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<ResidentListItem>> {
    assertCan(context, PERMISSIONS.RESIDENT_VIEW);

    const filter: Record<string, unknown> = {};
    if (query.category) filter.category = query.category;
    if (query.status) filter.status = query.status;
    if (query.propertyId) filter.propertyId = new Types.ObjectId(query.propertyId);

    // A name search has to reach the user collection, so it resolves to a set
    // of user ids first and constrains the tenant-scoped query with them.
    if (query.search) {
      const pattern = escapeRegex(query.search);
      const matchingUsers = await UserModel.find(
        {
          $or: [
            { firstName: { $regex: pattern, $options: 'i' } },
            { lastName: { $regex: pattern, $options: 'i' } },
          ],
          deletedAt: null,
        },
        { _id: 1 },
      )
        .limit(500)
        .lean();

      filter.$or = [
        { userId: { $in: matchingUsers.map((user) => user._id) } },
        { residentCode: { $regex: `^${pattern}`, $options: 'i' } },
      ];
    }

    const page = await membershipRepository.paginate(context, filter, pagination, {
      sort: { createdAt: -1 },
    });

    const users = await this.resolveUsers(page.items);
    const units = await this.resolveUnitNumbers(context, page.items);

    return {
      ...page,
      items: page.items
        .map((membership) => {
          const user = users.get(membership.userId.toHexString());
          return user ? this.toListItem(membership, user, units) : null;
        })
        .filter((item): item is ResidentListItem => item !== null),
    };
  }

  async detail(context: RequestContext, membershipId: string): Promise<ResidentDetail> {
    assertCan(context, PERMISSIONS.RESIDENT_VIEW);

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);
    const user = await userRepository.findById(membership.userId);
    if (!user) throw new NotFoundError('Resident');

    const occupancies = await propertyOccupancyRepository.findForMembership(
      context,
      membership._id,
    );
    const current = occupancies[0];

    let property: ResidentDetail['property'] = null;
    if (current) {
      const record = await propertyRepository.findById(context, current.propertyId);
      if (record) {
        property = {
          id: record._id.toHexString(),
          unitNumber: record.unitNumber,
          street: record.street,
          role: current.role,
          since: current.startedAt,
        };
      }
    }

    const units = new Map(property ? [[membership._id.toHexString(), property.unitNumber]] : []);

    return {
      ...this.toListItem(membership, user, units),
      firstName: user.firstName,
      ...(user.middleName ? { middleName: user.middleName } : {}),
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      ...(user.dateOfBirth ? { dateOfBirth: user.dateOfBirth } : {}),
      ...(user.gender ? { gender: user.gender } : {}),

      // Built from the stored last four digits, never by decrypting. The full
      // value requires resident.viewNin and goes through revealNin(), which
      // audits every read.
      ninMasked: user.ninLast4 ? `${'\u2022'.repeat(7)}${user.ninLast4}` : null,
      ninVerifiedAt: user.ninVerifiedAt ?? null,
      emailVerifiedAt: user.emailVerifiedAt ?? null,
      phoneVerifiedAt: user.phoneVerifiedAt ?? null,

      emergencyContact: user.emergencyContact ?? null,
      property,
      approvedAt: membership.approvedAt ?? null,
      movedInAt: membership.movedInAt ?? null,
    };
  }

  /**
   * Reveal a full NIN.
   *
   * Separate endpoint, separate permission, and an audit entry on every single
   * read — including the ones that succeed. A permission that is used routinely
   * and never recorded is indistinguishable from no permission at all.
   */
  async revealNin(context: RequestContext, membershipId: string): Promise<{ nin: string }> {
    assertCan(context, PERMISSIONS.RESIDENT_VIEW_NIN);

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);
    const user = await userRepository.findById(membership.userId);

    if (!user?.nin) {
      await auditService.recordFailure(context, {
        action: 'resident.nin_revealed',
        resource: 'resident',
        resourceId: membershipId,
        reason: 'no NIN on record',
      });
      throw new NotFoundError('NIN');
    }

    const nin = decryptField(user.nin, `user:${user._id.toHexString()}:nin`);

    await auditService.record(context, {
      action: 'resident.nin_revealed',
      resource: 'resident',
      resourceId: membershipId,
      // The value itself is never written to the trail — only the fact of the
      // read, and by whom.
      metadata: { subjectUserId: user._id.toHexString() },
    });

    return { nin };
  }

  /**
   * The minimal identity a gate screen may display.
   *
   * Kept as its own method rather than reusing `detail()` so the gate cannot
   * accidentally receive contact details or verification state.
   */
  async gateIdentity(context: RequestContext, membershipId: string): Promise<GateIdentity> {
    assertCan(context, PERMISSIONS.RESIDENT_VIEW);

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);
    const user = await userRepository.findById(membership.userId);
    if (!user) throw new NotFoundError('Resident');

    const units = await this.resolveUnitNumbers(context, [membership]);

    return {
      membershipId: membership._id.toHexString(),
      fullName: `${user.firstName} ${user.lastName}`,
      category: membership.category,
      unitNumber: units.get(membership._id.toHexString()) ?? null,
      photoUrl: user.photoUrl ?? null,
      status: membership.status,
      residentCode: membership.residentCode ?? null,
    };
  }

  /**
   * The caller's own gate identity.
   *
   * Separate from `gateIdentity` because it additionally asserts the membership
   * belongs to the caller. Reports a membership belonging to someone else as
   * not found rather than forbidden, so it cannot be used to discover which ids
   * exist.
   */
  async ownIdentity(context: RequestContext, membershipId: string): Promise<GateIdentity> {
    const membership = await membershipRepository.findByIdOrFail(context, membershipId);

    if (membership.userId.toHexString() !== context.userId) {
      throw new NotFoundError('Membership');
    }
    if (membership.status !== 'active') {
      throw new NotFoundError('Active membership');
    }

    return this.gateIdentity(context, membershipId);
  }

  /** Approve a pending membership and issue its resident code. */
  async approve(context: RequestContext, membershipId: string): Promise<MembershipDoc> {
    assertCan(context, PERMISSIONS.RESIDENT_APPROVE);

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);

    if (membership.status === 'active') {
      return membership;
    }

    const residentCode = membership.residentCode ?? (await this.nextResidentCode(context));

    const updated = await membershipRepository.updateById(context, membershipId, {
      $set: {
        status: 'active',
        residentCode,
        approvedAt: new Date(),
        approvedBy: new Types.ObjectId(context.userId),
        movedInAt: membership.movedInAt ?? new Date(),
      },
    });

    await auditService.record(context, {
      action: 'resident.approved',
      resource: 'resident',
      resourceId: membershipId,
      before: { status: membership.status },
      after: { status: 'active', residentCode },
    });

    // Emitted after the record is committed, so a failing welcome notification
    // cannot undo an approval. The bus isolates handler errors by design.
    events.emit('resident.approved', {
      residentId: membershipId,
      estateId: context.estateId,
      approvedBy: context.userId,
    });

    return updated;
  }

  async reject(context: RequestContext, membershipId: string, reason: string): Promise<void> {
    assertCan(context, PERMISSIONS.RESIDENT_APPROVE);

    await membershipRepository.updateById(context, membershipId, {
      $set: { status: 'suspended', rejectionReason: reason },
    });

    await auditService.record(context, {
      action: 'resident.rejected',
      resource: 'resident',
      resourceId: membershipId,
      metadata: { reason },
    });
  }

  // ---------------------------------------------------------------------------

  private toListItem(
    membership: MembershipDoc,
    user: UserDoc,
    units: Map<string, string>,
  ): ResidentListItem {
    return {
      membershipId: membership._id.toHexString(),
      userId: user._id.toHexString(),
      fullName: `${user.firstName} ${user.lastName}`,
      category: membership.category,
      status: membership.status,
      residentCode: membership.residentCode ?? null,
      unitNumber: units.get(membership._id.toHexString()) ?? null,
      photoUrl: user.photoUrl ?? null,
      verified: Boolean(user.ninVerifiedAt && user.emailVerifiedAt && user.phoneVerifiedAt),
      joinedAt: membership.createdAt,
    };
  }

  /** Batch the user lookups, so a page of 25 residents is two queries not 26. */
  private async resolveUsers(memberships: MembershipDoc[]): Promise<Map<string, UserDoc>> {
    if (memberships.length === 0) return new Map();

    const users = await UserModel.find({
      _id: { $in: memberships.map((membership) => membership.userId) },
    })
      .lean<UserDoc[]>()
      .exec();

    return new Map(users.map((user) => [user._id.toHexString(), user]));
  }

  private async resolveUnitNumbers(
    context: RequestContext,
    memberships: MembershipDoc[],
  ): Promise<Map<string, string>> {
    const withProperty = memberships.filter((membership) => membership.propertyId);
    if (withProperty.length === 0) return new Map();

    const properties = await propertyRepository.findMany(context, {
      _id: { $in: withProperty.map((membership) => membership.propertyId!) },
    });

    const byId = new Map(properties.map((property) => [property._id.toHexString(), property]));

    return new Map(
      withProperty
        .map((membership) => {
          const property = byId.get(membership.propertyId!.toHexString());
          return property ? ([membership._id.toHexString(), property.unitNumber] as const) : null;
        })
        .filter((entry): entry is readonly [string, string] => entry !== null),
    );
  }

  /**
   * Next sequential resident code, e.g. PGE-2026-00042.
   *
   * Derived from the count rather than a counter document, which is adequate at
   * this volume and avoids a second write per approval. A collision is caught
   * by the unique index and retried by the caller.
   */
  private async nextResidentCode(context: RequestContext): Promise<string> {
    const year = new Date().getFullYear();
    const count = await MembershipModel.countDocuments({
      estateId: new Types.ObjectId(context.estateId),
      residentCode: { $ne: null },
    });

    return `R-${year}-${String(count + 1).padStart(5, '0')}`;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const residentService = new ResidentService();
