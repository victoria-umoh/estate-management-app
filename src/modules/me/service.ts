import { NotFoundError } from '@/core/errors';
import { can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { estateRepository } from '@/modules/estate';
import { householdService } from '@/modules/household';
import { membershipRepository } from '@/modules/membership/repository';
import type { MembershipDoc } from '@/modules/membership/schema';
import { propertyRepository } from '@/modules/property';
import { userRepository } from '@/modules/user/repository';
import { vehicleRepository, vehicleService } from '@/modules/vehicle';
import { visitorPassRepository } from '@/modules/visitor';
import type { VisitorPassDoc } from '@/modules/visitor/schema';

/**
 * Everything a resident does on their own behalf.
 *
 * This exists so there is exactly one place that answers "who is calling?" —
 * and it answers from the session, never from the request body. Every
 * resident-facing route goes through here rather than accepting a membership id
 * from the browser, because a route that takes one is a route where changing a
 * single value in dev tools reads another household's data. That is not
 * hypothetical: it is precisely the bug that shipped in the first version of
 * the invoices list.
 *
 * The underlying services still run their own `assertMayActFor` checks. This is
 * a second, structural line of defence, not a replacement for them.
 */
export class MeService {
  /** The caller's membership, resolved from the session. */
  async membership(context: RequestContext): Promise<MembershipDoc> {
    const membership = await membershipRepository.findOne(context, { userId: context.userId });
    if (!membership) throw new NotFoundError('Membership');

    return membership;
  }

  async membershipId(context: RequestContext): Promise<string> {
    return (await this.membership(context))._id.toHexString();
  }

  /**
   * A filter fragment that narrows a list to the caller, unless they hold the
   * estate-wide permission.
   *
   * This exists because the same mistake has now been made five times:
   * `invoice.view`, `incident.view`, `resident.view`, `visitor.view`,
   * `vehicle.view` — each one held by residents so their own screen works, each
   * one also gating an estate-wide list that therefore leaked every household's
   * data to every resident. None was caught by a unit test, because a unit test
   * asserts the permission its author chose, and its author chose the one that
   * looked right.
   *
   * Spreading the result into a filter is one line and hard to get wrong:
   *
   *     const scope = await meService.narrowUnless(ctx, PERMISSIONS.VISITOR_VIEW_ALL, 'hostMembershipId');
   *     repository.paginate(ctx, { ...filters, ...scope }, ...)
   */
  async narrowUnless(
    context: RequestContext,
    widePermission: string,
    field: string,
  ): Promise<Record<string, unknown>> {
    if (can(context, widePermission)) return {};

    // No membership means no rows, rather than every row. Failing open here
    // would reintroduce precisely the bug this is here to prevent.
    const membership = await this.membership(context).catch(() => null);
    if (!membership) return { _id: null };

    return { [field]: membership._id };
  }

  /** Who the caller is, for the portal header and their own profile screen. */
  async profile(context: RequestContext) {
    const membership = await this.membership(context);
    const user = await userRepository.findById(context.userId);
    if (!user) throw new NotFoundError('User');

    const [property, estate] = await Promise.all([
      membership.propertyId ? propertyRepository.findById(context, membership.propertyId) : null,
      estateRepository.findById(context.estateId),
    ]);

    return {
      membershipId: membership._id.toHexString(),
      estateName: estate?.name ?? null,
      residentCode: membership.residentCode ?? null,
      category: membership.category,
      status: membership.status,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
      email: user.email,
      phone: user.phone ?? null,
      // Masked by the user serializer. The full value is behind its own
      // endpoint and its own audited permission.
      identityProvided: Boolean(user.nin),
      ninLast4: user.ninLast4 ?? null,
      property: property
        ? {
            id: property._id.toHexString(),
            unitNumber: property.unitNumber,
            block: property.block ?? null,
            street: property.street,
            type: property.type,
          }
        : null,
      movedInAt: membership.movedInAt ?? null,
    };
  }

  /** The caller's own property, with who else lives there. */
  async property(context: RequestContext) {
    const membership = await this.membership(context);
    if (!membership.propertyId) throw new NotFoundError('Property');

    const property = await propertyRepository.findByIdOrFail(context, membership.propertyId);

    const occupants = await membershipRepository.findMany(context, {
      propertyId: property._id,
      status: 'active',
    });

    return {
      id: property._id.toHexString(),
      unitNumber: property.unitNumber,
      block: property.block ?? null,
      street: property.street,
      type: property.type,
      occupancyStatus: property.occupancyStatus,
      bedrooms: property.bedrooms ?? null,
      maxOccupants: property.maxOccupants ?? null,
      currentOccupantCount: property.currentOccupantCount,
      registeredAt: property.registeredAt,
      // Names and categories only. A neighbour's contact details are not the
      // caller's to read just because they share a roof.
      occupants: occupants.map((occupant) => ({
        id: occupant._id.toHexString(),
        residentCode: occupant.residentCode ?? null,
        category: occupant.category,
        isSelf: occupant._id.equals(membership._id),
      })),
    };
  }

  async vehicles(context: RequestContext) {
    return vehicleRepository.findForOwner(context, await this.membershipId(context));
  }

  async registerVehicle(
    context: RequestContext,
    input: Omit<Parameters<typeof vehicleService.register>[1], 'ownerMembershipId'>,
  ) {
    return vehicleService.register(context, {
      ...input,
      ownerMembershipId: await this.membershipId(context),
    });
  }

  async household(context: RequestContext) {
    return householdService.listForGuardian(context, await this.membershipId(context));
  }

  async addDependant(
    context: RequestContext,
    input: Omit<Parameters<typeof householdService.addDependant>[1], 'guardianMembershipId'>,
  ) {
    return householdService.addDependant(context, {
      ...input,
      guardianMembershipId: await this.membershipId(context),
    });
  }

  async removeDependant(context: RequestContext, dependantId: string) {
    // The service verifies the dependant belongs to this guardian, so a
    // dependant id from another household is rejected there.
    return householdService.removeDependant(context, dependantId);
  }

  /** Visitor passes the caller is hosting, newest first. */
  async visitorPasses(context: RequestContext, pagination: { page?: number; limit?: number } = {}) {
    const membership = await this.membership(context);

    return visitorPassRepository.paginate(
      context,
      { hostMembershipId: membership._id },
      pagination,
      { sort: { expectedArrival: -1 } },
    );
  }

  async cancelVisitorPass(context: RequestContext, passId: string, reason?: string) {
    const pass = await this.assertHosts(context, passId);
    const { visitorService } = await import('@/modules/visitor');

    await visitorService.cancel(context, pass._id.toHexString(), reason);
  }

  /**
   * Confirm a pass is one the caller hosts.
   *
   * A 404 rather than a 403 on mismatch: confirming a pass exists but belongs
   * to someone else tells an attacker which codes are live.
   */
  private async assertHosts(context: RequestContext, passId: string): Promise<VisitorPassDoc> {
    const membership = await this.membership(context);

    const pass = await visitorPassRepository.findOne(context, {
      _id: passId,
      hostMembershipId: membership._id,
    });

    if (!pass) throw new NotFoundError('Visitor pass');
    return pass;
  }
}

export const meService = new MeService();
