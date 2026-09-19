import { Types, type ClientSession } from 'mongoose';
import { blindIndex, encryptField, decryptField, maskEmail, maskPhone } from '@/core/crypto';
import { BaseRepository, withTransaction } from '@/core/db';
import { AuthorizationError, ConflictError, ErrorCode, UnprocessableError } from '@/core/errors';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { membershipRepository } from '@/modules/membership/repository';
import { userRepository } from '@/modules/user/repository';
import { ChangeRequestModel, type ChangeRequestDoc, type ChangeableField } from './schema';

class ChangeRequestRepository extends BaseRepository<ChangeRequestDoc> {
  constructor() {
    super(ChangeRequestModel);
  }
}

export const changeRequestRepository = new ChangeRequestRepository();

/** Fields whose proposed value is itself sensitive and must be stored encrypted. */
const SENSITIVE_FIELDS: ReadonlySet<ChangeableField> = new Set(['nin']);

export interface SubmitChangeInput {
  membershipId: string;
  field: ChangeableField;
  value: string;
  reason?: string;
  documentIds?: string[];
}

/**
 * The approval workflow for load-bearing resident details.
 *
 * Requesting a change and making it are separate acts performed by different
 * people. That is the whole control: a resident proposes, someone with
 * authority reviews, and the change only lands on approval.
 */
export class ChangeRequestService {
  async submit(context: RequestContext, input: SubmitChangeInput): Promise<ChangeRequestDoc> {
    const membership = await membershipRepository.findByIdOrFail(context, input.membershipId);

    // A resident may propose changes to their own record; staff may propose for
    // anyone. Neither can approve their own request — see `review`.
    const isOwnRecord = membership.userId.toHexString() === context.userId;
    if (!isOwnRecord && !can(context, PERMISSIONS.RESIDENT_UPDATE)) {
      throw new AuthorizationError('You can only request changes to your own details.');
    }

    const user = await userRepository.findById(membership.userId);
    if (!user) throw new UnprocessableError('That resident no longer has an account.');

    // Catch the clash at submission rather than letting a reviewer approve a
    // change that cannot be applied.
    await this.assertValueAvailable(input.field, input.value, user._id);

    const existing = await changeRequestRepository.findOne(context, {
      membershipId: new Types.ObjectId(input.membershipId),
      field: input.field,
      status: 'pending',
    });

    if (existing) {
      throw new ConflictError(
        `A change to ${input.field} is already awaiting review for this resident.`,
      );
    }

    const sensitive = SENSITIVE_FIELDS.has(input.field);

    return withTransaction(async (session) => {
      const request = await changeRequestRepository.create(
        context,
        {
          membershipId: new Types.ObjectId(input.membershipId),
          userId: user._id,
          field: input.field,
          // A pending request must not become a plaintext copy of the value it
          // exists to protect.
          ...(sensitive
            ? {
                requestedValueEncrypted: encryptField(
                  input.value,
                  `change-request:${input.membershipId}:${input.field}`,
                ),
              }
            : { requestedValue: input.value }),
          currentValueLabel: this.labelFor(input.field, user),
          requestedValueLabel: this.maskValue(input.field, input.value),
          ...(input.reason ? { reason: input.reason } : {}),
          documentIds: (input.documentIds ?? []).map((id) => new Types.ObjectId(id)),
          status: 'pending',
          requestedBy: new Types.ObjectId(context.userId),
        },
        { session },
      );

      await auditService.record(context, {
        action: 'change_request.submitted',
        resource: 'change_request',
        resourceId: request._id,
        metadata: { field: input.field, membershipId: input.membershipId },
        session,
      });

      return request;
    });
  }

  /**
   * Approve or reject a request, applying the change on approval.
   *
   * Both happen in one transaction: a request marked approved whose change was
   * never applied is the worst of both outcomes, because the trail says it
   * happened and the record says otherwise.
   */
  async review(
    context: RequestContext,
    requestId: string,
    decision: { approve: boolean; note?: string },
  ): Promise<ChangeRequestDoc> {
    assertCan(context, PERMISSIONS.RESIDENT_APPROVE);

    const request = await changeRequestRepository.findByIdOrFail(context, requestId);

    if (request.status !== 'pending') {
      throw new ConflictError(`That request has already been ${request.status}.`);
    }

    // Separation of duties. Without this, a member of staff with both
    // resident.update and resident.approve could change their own NIN or move
    // themselves to another property unobserved.
    if (request.requestedBy.toHexString() === context.userId) {
      throw new AuthorizationError('You cannot review a change request you submitted yourself.');
    }

    return withTransaction(async (session) => {
      if (decision.approve) {
        await this.applyChange(context, request, session);
      }

      const updated = await changeRequestRepository.updateById(
        context,
        requestId,
        {
          $set: {
            status: decision.approve ? 'approved' : 'rejected',
            reviewedBy: new Types.ObjectId(context.userId),
            reviewedAt: new Date(),
            reviewNote: decision.note ?? null,
          },
        },
        { session },
      );

      await auditService.record(context, {
        action: decision.approve ? 'change_request.approved' : 'change_request.rejected',
        resource: 'change_request',
        resourceId: requestId,
        metadata: {
          field: request.field,
          membershipId: request.membershipId.toHexString(),
          requestedBy: request.requestedBy.toHexString(),
          ...(decision.note ? { note: decision.note } : {}),
        },
        session,
      });

      return updated;
    });
  }

  /** Withdraw a request. Only the submitter may do this. */
  async withdraw(context: RequestContext, requestId: string): Promise<void> {
    const request = await changeRequestRepository.findByIdOrFail(context, requestId);

    if (request.requestedBy.toHexString() !== context.userId) {
      throw new AuthorizationError('You can only withdraw your own requests.');
    }
    if (request.status !== 'pending') {
      throw new ConflictError(`That request has already been ${request.status}.`);
    }

    await changeRequestRepository.updateById(context, requestId, {
      $set: { status: 'withdrawn' },
    });

    await auditService.record(context, {
      action: 'change_request.withdrawn',
      resource: 'change_request',
      resourceId: requestId,
      metadata: { field: request.field },
    });
  }

  async listPending(context: RequestContext, pagination: { page?: number; limit?: number } = {}) {
    assertCan(context, PERMISSIONS.RESIDENT_APPROVE);

    return changeRequestRepository.paginate(context, { status: 'pending' }, pagination, {
      sort: { createdAt: 1 },
    });
  }

  // ---------------------------------------------------------------------------

  private async applyChange(
    context: RequestContext,
    request: ChangeRequestDoc,
    session: ClientSession,
  ): Promise<void> {
    const value = request.requestedValueEncrypted
      ? decryptField(
          request.requestedValueEncrypted,
          `change-request:${request.membershipId.toHexString()}:${request.field}`,
        )
      : request.requestedValue;

    if (!value) throw new UnprocessableError('That request has no value to apply.');

    // Re-checked at approval, not only at submission: a competing account may
    // have taken the value while the request sat in the queue.
    await this.assertValueAvailable(request.field, value, request.userId);

    switch (request.field) {
      case 'nin':
        await userRepository.updateById(
          request.userId,
          {
            $set: {
              nin: encryptField(value, `user:${request.userId.toHexString()}:nin`),
              ninIndex: blindIndex(value, 'nin'),
              ninLast4: value.replace(/\D/g, '').slice(-4),
              // Cleared deliberately: a new number has not been verified, and
              // carrying the old verification across would be a lie.
              ninVerifiedAt: null,
              ninVerificationRef: null,
            },
          },
          { session },
        );
        break;

      case 'phone':
        await userRepository.updateById(
          request.userId,
          {
            $set: {
              phone: value,
              phoneIndex: blindIndex(value, 'phone'),
              phoneVerifiedAt: null,
            },
          },
          { session },
        );
        break;

      case 'email':
        await userRepository.updateById(
          request.userId,
          {
            $set: {
              email: value.toLowerCase(),
              emailIndex: blindIndex(value, 'email'),
              emailVerifiedAt: null,
            },
          },
          { session },
        );
        break;

      case 'propertyId':
        await membershipRepository.updateById(
          context,
          request.membershipId,
          { $set: { propertyId: new Types.ObjectId(value) } },
          { session },
        );
        break;

      case 'category':
        await membershipRepository.updateById(
          context,
          request.membershipId,
          { $set: { category: value as never } },
          { session },
        );
        break;

      case 'name': {
        const [firstName, ...rest] = value.trim().split(/\s+/);
        await userRepository.updateById(
          request.userId,
          { $set: { firstName, lastName: rest.join(' ') || firstName } },
          { session },
        );
        break;
      }
    }
  }

  /** Reject a value already held by a different account. */
  private async assertValueAvailable(
    field: ChangeableField,
    value: string,
    ownUserId: Types.ObjectId,
  ): Promise<void> {
    const finder = {
      nin: () => userRepository.findByNin(value),
      phone: () => userRepository.findByPhone(value),
      email: () => userRepository.findByEmail(value),
    }[field as 'nin' | 'phone' | 'email'];

    if (!finder) return;

    const holder = await finder();
    if (holder && !holder._id.equals(ownUserId)) {
      throw new ConflictError(
        `That ${field} is already registered to another account.`,
        ErrorCode.DUPLICATE_IDENTITY,
      );
    }
  }

  /** Masked description of the current value, for the reviewer's screen. */
  private labelFor(
    field: ChangeableField,
    user: Awaited<ReturnType<typeof userRepository.findById>>,
  ): string | null {
    if (!user) return null;

    switch (field) {
      case 'nin':
        return user.ninLast4 ? `${'•'.repeat(7)}${user.ninLast4}` : 'Not on record';
      case 'phone':
        return maskPhone(user.phone);
      case 'email':
        return maskEmail(user.email);
      case 'name':
        return `${user.firstName} ${user.lastName}`;
      default:
        return null;
    }
  }

  private maskValue(field: ChangeableField, value: string): string {
    switch (field) {
      case 'nin': {
        const digits = value.replace(/\D/g, '');
        return `${'•'.repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
      }
      case 'phone':
        return maskPhone(value);
      case 'email':
        return maskEmail(value);
      default:
        return value;
    }
  }
}

export const changeRequestService = new ChangeRequestService();
