import { Types } from 'mongoose';
import { blindIndex, encryptField } from '@/core/crypto';
import { BaseRepository, withTransaction } from '@/core/db';
import { AuthorizationError, ConflictError, UnprocessableError } from '@/core/errors';
import { ErrorCode } from '@/core/errors';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { membershipRepository } from '@/modules/membership/repository';
import { userRepository } from '@/modules/user/repository';
import { DependantModel, type DependantDoc, type DependantRelationship } from './schema';

class DependantRepository extends BaseRepository<DependantDoc> {
  constructor() {
    super(DependantModel);
  }

  findForGuardian(context: RequestContext, guardianMembershipId: string): Promise<DependantDoc[]> {
    return this.findMany(
      context,
      { guardianMembershipId: new Types.ObjectId(guardianMembershipId), isActive: true },
      { sort: { firstName: 1 } },
    );
  }
}

export const dependantRepository = new DependantRepository();

export interface AddDependantInput {
  guardianMembershipId: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  dateOfBirth?: Date;
  gender?: DependantDoc['gender'];
  relationship: DependantRelationship;
  phone?: string;
  nin?: string;
  schoolOrWorkplace?: string;
}

/**
 * Households and dependants.
 *
 * Residents manage their own household; staff manage anyone's. That split is
 * enforced here rather than by giving residents a broad permission, because
 * `household.create` on its own would otherwise let any resident add a
 * dependant to a neighbour's house — and a dependant is someone the gate will
 * admit.
 */
export class HouseholdService {
  async addDependant(context: RequestContext, input: AddDependantInput): Promise<DependantDoc> {
    assertCan(context, PERMISSIONS.HOUSEHOLD_CREATE);
    await this.assertMayManage(context, input.guardianMembershipId);

    if (input.dateOfBirth && input.dateOfBirth.getTime() > Date.now()) {
      throw new UnprocessableError('A date of birth cannot be in the future.');
    }

    // A NIN identifies one person platform-wide. Checking both collections
    // stops the same individual being registered once as an account holder and
    // again as somebody's dependant.
    if (input.nin) {
      const existingUser = await userRepository.findByNin(input.nin);
      if (existingUser) {
        throw new ConflictError(
          'That NIN is already registered to an account.',
          ErrorCode.DUPLICATE_IDENTITY,
        );
      }

      const existingDependant = await DependantModel.findOne({
        ninIndex: blindIndex(input.nin, 'nin'),
        deletedAt: null,
      }).lean();

      if (existingDependant) {
        throw new ConflictError(
          'That NIN is already registered to another household member.',
          ErrorCode.DUPLICATE_IDENTITY,
        );
      }
    }

    const guardian = await membershipRepository.findByIdOrFail(context, input.guardianMembershipId);

    return withTransaction(async (session) => {
      const dependant = await dependantRepository.create(
        context,
        {
          guardianMembershipId: new Types.ObjectId(input.guardianMembershipId),
          ...(guardian.propertyId ? { propertyId: guardian.propertyId } : {}),
          firstName: input.firstName.trim(),
          ...(input.middleName ? { middleName: input.middleName.trim() } : {}),
          lastName: input.lastName.trim(),
          ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
          ...(input.gender ? { gender: input.gender } : {}),
          relationship: input.relationship,
          ...(input.phone
            ? { phone: input.phone, phoneIndex: blindIndex(input.phone, 'phone') }
            : {}),
          ...(input.nin
            ? {
                nin: encryptField(input.nin, `dependant:${input.guardianMembershipId}:nin`),
                ninIndex: blindIndex(input.nin, 'nin'),
                ninLast4: input.nin.replace(/\D/g, '').slice(-4),
              }
            : {}),
          ...(input.schoolOrWorkplace ? { schoolOrWorkplace: input.schoolOrWorkplace } : {}),
          isActive: true,
        },
        { session },
      );

      await auditService.record(context, {
        action: 'household.dependant_added',
        resource: 'dependant',
        resourceId: dependant._id,
        // Relationship and a presence flag only — the NIN is never written to
        // the trail. The flag deliberately avoids the substring "nin", because
        // audit metadata redaction matches field names loosely and would blank
        // a boolean named `hasNin`. Over-redacting is the correct default here,
        // so the field is named around it rather than the filter loosened.
        metadata: {
          guardianMembershipId: input.guardianMembershipId,
          relationship: input.relationship,
          identityProvided: Boolean(input.nin),
        },
        session,
      });

      return dependant;
    });
  }

  async listForGuardian(
    context: RequestContext,
    guardianMembershipId: string,
  ): Promise<DependantDoc[]> {
    assertCan(context, PERMISSIONS.HOUSEHOLD_VIEW);
    await this.assertMayManage(context, guardianMembershipId);

    return dependantRepository.findForGuardian(context, guardianMembershipId);
  }

  async updateDependant(
    context: RequestContext,
    dependantId: string,
    updates: Partial<
      Pick<AddDependantInput, 'firstName' | 'lastName' | 'phone' | 'schoolOrWorkplace'>
    >,
  ): Promise<DependantDoc> {
    assertCan(context, PERMISSIONS.HOUSEHOLD_UPDATE);

    const dependant = await dependantRepository.findByIdOrFail(context, dependantId);
    await this.assertMayManage(context, dependant.guardianMembershipId.toHexString());

    const updated = await dependantRepository.updateById(context, dependantId, {
      $set: {
        ...updates,
        ...(updates.phone ? { phoneIndex: blindIndex(updates.phone, 'phone') } : {}),
      },
    });

    await auditService.record(context, {
      action: 'household.dependant_updated',
      resource: 'dependant',
      resourceId: dependantId,
      before: { firstName: dependant.firstName, lastName: dependant.lastName },
      after: { firstName: updated.firstName, lastName: updated.lastName },
    });

    return updated;
  }

  /**
   * Mark a dependant as departed.
   *
   * Not a delete: the gate log records who entered and left, and those entries
   * must stay resolvable long after a child has grown up or a driver has
   * changed employer.
   */
  async removeDependant(
    context: RequestContext,
    dependantId: string,
    reason?: string,
  ): Promise<void> {
    assertCan(context, PERMISSIONS.HOUSEHOLD_DELETE);

    const dependant = await dependantRepository.findByIdOrFail(context, dependantId);
    await this.assertMayManage(context, dependant.guardianMembershipId.toHexString());

    await dependantRepository.updateById(context, dependantId, {
      $set: { isActive: false, departedAt: new Date() },
    });

    await auditService.record(context, {
      action: 'household.dependant_removed',
      resource: 'dependant',
      resourceId: dependantId,
      ...(reason ? { metadata: { reason } } : {}),
    });
  }

  /**
   * A resident may manage only their own household; staff may manage any.
   *
   * `household.create` alone would otherwise let any resident add a dependant
   * to a neighbour's house — and a dependant is somebody the gate will admit.
   */
  private async assertMayManage(
    context: RequestContext,
    guardianMembershipId: string,
  ): Promise<void> {
    // Staff privilege: being able to approve residents implies managing their
    // households.
    if (can(context, PERMISSIONS.RESIDENT_APPROVE) || can(context, PERMISSIONS.RESIDENT_UPDATE)) {
      return;
    }

    const guardian = await membershipRepository.findByIdOrFail(context, guardianMembershipId);

    if (guardian.userId.toHexString() !== context.userId) {
      throw new AuthorizationError('You can only manage your own household.');
    }
  }
}

export const householdService = new HouseholdService();
