import { Types } from 'mongoose';
import { generateShortCode } from '@/core/crypto';
import { BaseRepository, withTransaction, type PaginatedResult } from '@/core/db';
import { events } from '@/core/events';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { credentialService } from '@/modules/credential';
import { estateRepository } from '@/modules/estate';
import { membershipRepository } from '@/modules/membership/repository';
import { movementService } from '@/modules/movement';
import { normalisePlate } from '@/modules/vehicle';
import { TemporaryPassModel, type TemporaryPassDoc } from './schema';

const log = createLogger('temporary-pass');

class TemporaryPassRepository extends BaseRepository<TemporaryPassDoc> {
  constructor() {
    super(TemporaryPassModel);
  }

  findByCode(context: RequestContext, code: string): Promise<TemporaryPassDoc | null> {
    return this.findOne(context, { code: code.trim().toUpperCase() });
  }

  findCurrentlyInside(context: RequestContext): Promise<TemporaryPassDoc[]> {
    return this.findMany(context, { status: 'active', inside: true }, { sort: { lastUsedAt: -1 } });
  }
}

export const temporaryPassRepository = new TemporaryPassRepository();

export interface IssueTemporaryPassInput {
  /** Resolved from the session by the route, never taken from the body. */
  sponsorMembershipId: string;
  holderName: string;
  holderPhone?: string;
  company?: string;
  purpose: string;
  vehiclePlate?: string;
  validFrom?: Date;
  validUntil: Date;
  notes?: string;
}

/**
 * Temporary passes.
 *
 * The distinction from a visitor pass is the whole design: this one is REUSABLE
 * inside its window. `recordUse` therefore increments and flips a presence flag
 * rather than closing anything, and nothing in this service moves a pass to a
 * terminal state except revocation and the expiry sweep.
 */
export class TemporaryPassService {
  /** Issue a pass for a bounded period. */
  async issue(
    context: RequestContext,
    input: IssueTemporaryPassInput,
  ): Promise<{ pass: TemporaryPassDoc; token: string }> {
    assertCan(context, PERMISSIONS.TEMPORARY_PASS_CREATE);

    const validFrom = input.validFrom ?? new Date();

    if (input.validUntil <= validFrom) {
      throw new UnprocessableError('The pass must expire after it becomes valid.');
    }

    const estate = await estateRepository.findById(context.estateId);
    const maxDays = estate?.settings.temporaryPassMaxDurationDays ?? 30;
    const durationDays = (input.validUntil.getTime() - validFrom.getTime()) / 86_400_000;

    if (durationDays > maxDays) {
      throw new UnprocessableError(`A temporary pass may not exceed ${maxDays} days.`);
    }

    const sponsor = await membershipRepository.findByIdOrFail(context, input.sponsorMembershipId);

    return withTransaction(async (session) => {
      const pass = await temporaryPassRepository.create(
        context,
        {
          code: await this.uniqueCode(context),
          holderName: input.holderName.trim(),
          ...(input.holderPhone ? { holderPhone: input.holderPhone } : {}),
          ...(input.company ? { company: input.company.trim() } : {}),
          purpose: input.purpose.trim(),
          sponsorMembershipId: new Types.ObjectId(input.sponsorMembershipId),
          ...(sponsor.propertyId ? { propertyId: sponsor.propertyId } : {}),
          ...(input.vehiclePlate
            ? {
                vehiclePlate: input.vehiclePlate.toUpperCase(),
                vehiclePlateNormalised: normalisePlate(input.vehiclePlate),
              }
            : {}),
          validFrom,
          validUntil: input.validUntil,
          status: 'active',
          useCount: 0,
          inside: false,
          issuedBy: new Types.ObjectId(context.userId),
          ...(input.notes ? { notes: input.notes } : {}),
        },
        { session },
      );

      const { token, credential } = await credentialService.issue(context, {
        subject: 'temporary-pass',
        subjectId: pass._id.toHexString(),
        display: {
          primaryLabel: pass.holderName,
          secondaryLabel: pass.purpose,
          unitNumber: null,
          category: pass.company ? `Temporary · ${pass.company}` : 'Temporary pass',
          photoUrl: null,
        },
        validFrom,
        validUntil: input.validUntil,
      });

      await temporaryPassRepository.updateById(
        context,
        pass._id,
        { $set: { credentialId: credential._id } },
        { session },
      );

      await auditService.record(context, {
        action: 'temporary_pass.issued',
        resource: 'temporary_pass',
        resourceId: pass._id,
        metadata: {
          code: pass.code,
          sponsorMembershipId: input.sponsorMembershipId,
          validUntil: input.validUntil.toISOString(),
        },
        session,
      });

      events.emit('temporaryPass.issued', {
        passId: pass._id.toHexString(),
        estateId: context.estateId,
        sponsorId: input.sponsorMembershipId,
      });

      return { pass, token };
    });
  }

  /**
   * What the officer sees at the barrier.
   *
   * Always answers rather than throwing: a refused pass is an ordinary event
   * the officer must see and the log must record.
   */
  async verifyAtGate(
    context: RequestContext,
    code: string,
  ): Promise<{ usable: boolean; message: string; pass: TemporaryPassDoc | null }> {
    assertCan(context, PERMISSIONS.TEMPORARY_PASS_VERIFY);

    const pass = await temporaryPassRepository.findByCode(context, code);

    if (!pass) return { usable: false, message: 'Pass not recognised.', pass: null };
    if (pass.status === 'revoked') {
      return { usable: false, message: 'This pass has been cancelled.', pass };
    }

    const now = Date.now();
    if (pass.validFrom.getTime() > now) {
      return { usable: false, message: 'This pass is not valid yet.', pass };
    }
    if (pass.status === 'expired' || pass.validUntil.getTime() <= now) {
      return { usable: false, message: 'This pass has expired.', pass };
    }

    return {
      usable: true,
      message: pass.inside ? 'Valid. Currently inside.' : 'Valid. Admit.',
      pass,
    };
  }

  /**
   * Record a passage.
   *
   * This is where a temporary pass differs from every other pass in the system:
   * it does NOT close. A contractor on a three-day job goes in and out several
   * times a day, and a pass spent on the first entry would have them queuing at
   * the office every lunchtime. The window is what limits access; the passages
   * are counted, not rationed.
   */
  async recordUse(
    context: RequestContext,
    passId: string,
    input: { gateId: string; direction: 'in' | 'out'; notes?: string },
  ): Promise<TemporaryPassDoc> {
    assertCan(context, PERMISSIONS.TEMPORARY_PASS_VERIFY);

    const pass = await temporaryPassRepository.findByIdOrFail(context, passId);

    if (pass.status !== 'active') {
      throw new ConflictError(`That pass is ${pass.status} and cannot be used.`);
    }

    const now = new Date();
    if (pass.validFrom > now) {
      throw new ConflictError('That pass is not valid yet.');
    }
    if (pass.validUntil <= now) {
      throw new ConflictError('That pass has expired.');
    }
    if (input.direction === 'in' && pass.inside) {
      throw new ConflictError('That pass holder is already inside.');
    }
    if (input.direction === 'out' && !pass.inside) {
      throw new ConflictError('That pass holder is not currently inside.');
    }

    await movementService.record(context, {
      gateId: input.gateId,
      direction: input.direction,
      subject: 'temporary-pass',
      subjectId: pass._id.toHexString(),
      ...(pass.credentialId ? { credentialId: pass.credentialId.toHexString() } : {}),
      subjectLabel: pass.holderName,
      vehiclePlate: pass.vehiclePlate ?? null,
      admitted: true,
      method: 'code',
      ...(input.notes ? { notes: input.notes } : {}),
    });

    // Status stays `active`: the count and the presence flag are the state that
    // changes, never the lifecycle.
    return temporaryPassRepository.updateById(context, passId, {
      $inc: { useCount: 1 },
      $set: {
        lastUsedAt: now,
        lastGateId: new Types.ObjectId(input.gateId),
        inside: input.direction === 'in',
      },
    });
  }

  /** Withdraw a pass before its window closes. */
  async revoke(context: RequestContext, passId: string, reason: string): Promise<TemporaryPassDoc> {
    assertCan(context, PERMISSIONS.TEMPORARY_PASS_REVOKE);

    const pass = await temporaryPassRepository.findByIdOrFail(context, passId);

    if (pass.status === 'revoked') {
      throw new ConflictError('That pass has already been revoked.');
    }

    const updated = await temporaryPassRepository.updateById(context, passId, {
      $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason },
    });

    if (pass.credentialId) {
      await credentialService
        .revoke(context, pass.credentialId.toHexString(), reason)
        .catch((error: unknown) => {
          log.error({ err: error, passId }, 'failed to revoke credential for temporary pass');
        });
    }

    await auditService.record(context, {
      action: 'temporary_pass.revoked',
      resource: 'temporary_pass',
      resourceId: passId,
      metadata: { code: pass.code, reason },
    });

    events.emit('temporaryPass.revoked', {
      passId,
      estateId: context.estateId,
      reason,
    });

    return updated;
  }

  async list(
    context: RequestContext,
    filters: { status?: TemporaryPassDoc['status']; sponsorMembershipId?: string },
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<TemporaryPassDoc>> {
    assertCan(context, PERMISSIONS.TEMPORARY_PASS_VERIFY);

    const filter: Record<string, unknown> = {};
    if (filters.status) filter.status = filters.status;
    if (filters.sponsorMembershipId) {
      filter.sponsorMembershipId = new Types.ObjectId(filters.sponsorMembershipId);
    }

    return temporaryPassRepository.paginate(context, filter, pagination, {
      sort: { createdAt: -1 },
    });
  }

  /** Close the window on passes whose period has ended. */
  async expireLapsed(context: RequestContext): Promise<number> {
    return temporaryPassRepository.updateMany(
      context,
      { status: 'active', validUntil: { $lte: new Date() } },
      { $set: { status: 'expired' } },
    );
  }

  // ---------------------------------------------------------------------------

  /** Retry on collision rather than trusting six characters to never repeat. */
  private async uniqueCode(context: RequestContext): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateShortCode();
      if (!(await temporaryPassRepository.findByCode(context, code))) return code;
    }

    throw new ConflictError('Could not allocate a pass code. Please try again.');
  }
}

export const temporaryPassService = new TemporaryPassService();
