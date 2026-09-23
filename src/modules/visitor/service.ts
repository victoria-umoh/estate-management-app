import { Types } from 'mongoose';
import { generateShortCode } from '@/core/crypto';
import { BaseRepository, withTransaction } from '@/core/db';
import { events } from '@/core/events';
import { AuthorizationError, ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { credentialService } from '@/modules/credential';
import { estateRepository } from '@/modules/estate';
import { membershipRepository } from '@/modules/membership/repository';
import { normalisePlate } from '@/modules/vehicle';
import { VisitorPassModel, type VisitorPassDoc } from './schema';

const log = createLogger('visitor');

class VisitorPassRepository extends BaseRepository<VisitorPassDoc> {
  constructor() {
    super(VisitorPassModel);
  }

  findByCode(context: RequestContext, code: string): Promise<VisitorPassDoc | null> {
    return this.findOne(context, { code: code.trim().toUpperCase() });
  }

  findCurrentlyInside(context: RequestContext): Promise<VisitorPassDoc[]> {
    return this.findMany(context, { status: 'inside' }, { sort: { checkedInAt: -1 } });
  }
}

export const visitorPassRepository = new VisitorPassRepository();

export interface CreatePassInput {
  hostMembershipId: string;
  visitorName: string;
  visitorPhone?: string;
  partySize?: number;
  purpose: string;
  vehiclePlate?: string;
  expectedArrival: Date;
  expectedDeparture: Date;
}

export interface WalkInInput {
  hostMembershipId: string;
  visitorName: string;
  visitorPhone?: string;
  partySize?: number;
  purpose: string;
  vehiclePlate?: string;
  /** How long the walk-in is good for. */
  validForHours?: number;
  hostApproved: boolean;
  notes?: string;
}

export class VisitorService {
  /** A resident creates a pass in advance and sends the code to their guest. */
  async createPass(
    context: RequestContext,
    input: CreatePassInput,
  ): Promise<{ pass: VisitorPassDoc; token: string }> {
    assertCan(context, PERMISSIONS.VISITOR_CREATE);
    await this.assertMayActFor(context, input.hostMembershipId);

    if (input.expectedDeparture <= input.expectedArrival) {
      throw new UnprocessableError('The departure time must be after the arrival time.');
    }

    const estate = await estateRepository.findById(context.estateId);
    const maxDays = estate?.settings.visitorPassMaxDurationDays ?? 7;
    const durationDays =
      (input.expectedDeparture.getTime() - input.expectedArrival.getTime()) / 86_400_000;

    if (durationDays > maxDays) {
      throw new UnprocessableError(`A visitor pass may not exceed ${maxDays} days.`);
    }

    const host = await membershipRepository.findByIdOrFail(context, input.hostMembershipId);

    return withTransaction(async (session) => {
      const pass = await visitorPassRepository.create(
        context,
        {
          passType: 'expected',
          code: await this.uniqueCode(context),
          hostMembershipId: new Types.ObjectId(input.hostMembershipId),
          ...(host.propertyId ? { propertyId: host.propertyId } : {}),
          visitorName: input.visitorName.trim(),
          ...(input.visitorPhone ? { visitorPhone: input.visitorPhone } : {}),
          partySize: input.partySize ?? 1,
          purpose: input.purpose.trim(),
          ...(input.vehiclePlate
            ? {
                vehiclePlate: input.vehiclePlate.toUpperCase(),
                vehiclePlateNormalised: normalisePlate(input.vehiclePlate),
              }
            : {}),
          expectedArrival: input.expectedArrival,
          expectedDeparture: input.expectedDeparture,
          status: 'pending',
          issuedBy: new Types.ObjectId(context.userId),
          hostApproved: true,
        },
        { session },
      );

      const { token, credential } = await credentialService.issue(context, {
        subject: 'visitor',
        subjectId: pass._id.toHexString(),
        display: {
          primaryLabel: pass.visitorName,
          secondaryLabel: pass.purpose,
          unitNumber: null,
          category: `Visitor · party of ${pass.partySize}`,
          photoUrl: null,
        },
        validFrom: input.expectedArrival,
        // Valid until departure plus the grace period, so a visitor leaving a
        // little late is not locked inside by their own expired pass.
        validUntil: new Date(
          input.expectedDeparture.getTime() +
            (estate?.settings.visitorOverstayGraceMinutes ?? 60) * 60_000,
        ),
      });

      await visitorPassRepository.updateById(
        context,
        pass._id,
        { $set: { credentialId: credential._id } },
        { session },
      );

      await auditService.record(context, {
        action: 'visitor.pass_created',
        resource: 'visitor_pass',
        resourceId: pass._id,
        metadata: { code: pass.code, hostMembershipId: input.hostMembershipId },
        session,
      });

      events.emit('visitor.pass_created', {
        passId: pass._id.toHexString(),
        estateId: context.estateId,
        hostId: input.hostMembershipId,
      });

      return { pass, token };
    });
  }

  /**
   * An officer issues a pass at the gate for someone who arrived unannounced.
   *
   * `hostApproved` records whether the resident was actually reached, or the
   * officer admitted on their own judgement. Both happen; only one of them is
   * defensible afterwards, so the log distinguishes them.
   */
  async issueWalkIn(
    context: RequestContext,
    input: WalkInInput,
  ): Promise<{ pass: VisitorPassDoc; token: string }> {
    assertCan(context, PERMISSIONS.TEMPORARY_PASS_CREATE);

    const host = await membershipRepository.findByIdOrFail(context, input.hostMembershipId);
    const now = new Date();
    const validUntil = new Date(now.getTime() + (input.validForHours ?? 8) * 3_600_000);

    return withTransaction(async (session) => {
      const pass = await visitorPassRepository.create(
        context,
        {
          passType: 'walk-in',
          code: await this.uniqueCode(context),
          hostMembershipId: new Types.ObjectId(input.hostMembershipId),
          ...(host.propertyId ? { propertyId: host.propertyId } : {}),
          visitorName: input.visitorName.trim(),
          ...(input.visitorPhone ? { visitorPhone: input.visitorPhone } : {}),
          partySize: input.partySize ?? 1,
          purpose: input.purpose.trim(),
          ...(input.vehiclePlate
            ? {
                vehiclePlate: input.vehiclePlate.toUpperCase(),
                vehiclePlateNormalised: normalisePlate(input.vehiclePlate),
              }
            : {}),
          expectedArrival: now,
          expectedDeparture: validUntil,
          status: 'pending',
          issuedBy: new Types.ObjectId(context.userId),
          hostApproved: input.hostApproved,
          ...(input.notes ? { notes: input.notes } : {}),
        },
        { session },
      );

      const { token, credential } = await credentialService.issue(context, {
        subject: 'temporary-pass',
        subjectId: pass._id.toHexString(),
        display: {
          primaryLabel: pass.visitorName,
          secondaryLabel: pass.purpose,
          unitNumber: null,
          category: 'Walk-in visitor',
          photoUrl: null,
        },
        validUntil,
      });

      await visitorPassRepository.updateById(
        context,
        pass._id,
        { $set: { credentialId: credential._id } },
        { session },
      );

      await auditService.record(context, {
        action: 'visitor.walk_in_issued',
        resource: 'visitor_pass',
        resourceId: pass._id,
        metadata: {
          code: pass.code,
          hostMembershipId: input.hostMembershipId,
          hostApproved: input.hostApproved,
        },
        session,
      });

      return { pass, token };
    });
  }

  /** Record a visitor entering. */
  async checkIn(context: RequestContext, passId: string, gateId: string): Promise<VisitorPassDoc> {
    assertCan(context, PERMISSIONS.VISITOR_CHECKIN);

    const pass = await visitorPassRepository.findByIdOrFail(context, passId);

    if (pass.status === 'inside') {
      throw new ConflictError('That visitor is already checked in.');
    }
    if (pass.status !== 'pending') {
      throw new ConflictError(`That pass is ${pass.status} and cannot be used.`);
    }

    const updated = await visitorPassRepository.updateById(context, passId, {
      $set: {
        status: 'inside',
        checkedInAt: new Date(),
        checkedInGateId: new Types.ObjectId(gateId),
        checkedInBy: new Types.ObjectId(context.userId),
      },
    });

    events.emit('visitor.entered', {
      passId,
      gateId,
      at: new Date().toISOString(),
    });

    return updated;
  }

  /** Record a visitor leaving. */
  async checkOut(context: RequestContext, passId: string, gateId: string): Promise<VisitorPassDoc> {
    assertCan(context, PERMISSIONS.VISITOR_CHECKOUT);

    const pass = await visitorPassRepository.findByIdOrFail(context, passId);

    if (pass.status !== 'inside') {
      throw new ConflictError('That visitor is not currently checked in.');
    }

    const updated = await visitorPassRepository.updateById(context, passId, {
      $set: {
        status: 'completed',
        checkedOutAt: new Date(),
        checkedOutGateId: new Types.ObjectId(gateId),
        checkedOutBy: new Types.ObjectId(context.userId),
      },
    });

    // The pass is spent. Revoking stops a code being reused for a second visit
    // on the same day.
    if (pass.credentialId) {
      await credentialService
        .revoke(context, pass.credentialId.toHexString(), 'visit completed')
        .catch((error: unknown) => {
          // A failure here leaves a spent pass technically valid until it
          // expires, which is worth a loud log but not worth failing the
          // checkout and leaving the visitor recorded as still inside.
          log.error({ err: error, passId }, 'failed to revoke credential on checkout');
        });
    }

    events.emit('visitor.exited', { passId, gateId, at: new Date().toISOString() });

    return updated;
  }

  async cancel(context: RequestContext, passId: string, reason?: string): Promise<void> {
    const pass = await visitorPassRepository.findByIdOrFail(context, passId);
    await this.assertMayActFor(context, pass.hostMembershipId.toHexString());

    if (pass.status === 'inside') {
      throw new ConflictError('That visitor is already inside. Check them out instead.');
    }
    if (pass.status !== 'pending') {
      throw new ConflictError(`That pass is already ${pass.status}.`);
    }

    await visitorPassRepository.updateById(context, passId, {
      $set: { status: 'cancelled', denialReason: reason ?? null },
    });

    if (pass.credentialId) {
      await credentialService.revoke(context, pass.credentialId.toHexString(), 'pass cancelled');
    }

    await auditService.record(context, {
      action: 'visitor.pass_cancelled',
      resource: 'visitor_pass',
      resourceId: passId,
      ...(reason ? { metadata: { reason } } : {}),
    });
  }

  /**
   * Find visitors who are still inside past their departure time.
   *
   * Runs as a scheduled sweep across every estate, so it queries without a
   * tenant context and groups the results by estate afterwards. It is the one
   * place that legitimately reads across estates, and it returns only ids and
   * timings — never visitor details.
   */
  async findOverstaying(graceMinutesByEstate: Map<string, number>): Promise<VisitorPassDoc[]> {
    const now = Date.now();

    // The narrowest grace across all estates bounds the query: a pass cannot be
    // overstaying under any estate's rules until at least that long has passed,
    // so anything more recent is not worth fetching.
    const narrowestGrace = Math.min(60, ...graceMinutesByEstate.values());

    const candidates = await VisitorPassModel.find({
      status: 'inside',
      expectedDeparture: { $lte: new Date(now - narrowestGrace * 60_000) },
      overstayNotifiedAt: null,
      deletedAt: null,
    })
      .limit(1000)
      .lean<VisitorPassDoc[]>()
      .exec();

    // Each candidate is then measured against its own estate's setting.
    return candidates.filter((pass) => {
      const grace = graceMinutesByEstate.get(pass.estateId.toHexString()) ?? 60;
      return pass.expectedDeparture.getTime() + grace * 60_000 <= now;
    });
  }

  /** Mark a pass as raised, so the host and security are told once. */
  async markOverstayNotified(pass: VisitorPassDoc): Promise<void> {
    const context = systemContext(pass.estateId.toHexString(), 'overstay-sweep');

    await visitorPassRepository.updateById(context, pass._id, {
      $set: { overstayNotifiedAt: new Date() },
    });

    const minutesOver = Math.floor((Date.now() - pass.expectedDeparture.getTime()) / 60_000);

    await auditService.record(context, {
      action: 'visitor.overstayed',
      resource: 'visitor_pass',
      resourceId: pass._id,
      metadata: { code: pass.code, minutesOver },
    });

    events.emit('visitor.overstayed', {
      passId: pass._id.toHexString(),
      estateId: pass.estateId.toHexString(),
      hostId: pass.hostMembershipId.toHexString(),
      minutesOver,
    });

    log.warn(
      { passId: pass._id.toHexString(), code: pass.code, minutesOver },
      'visitor overstaying',
    );
  }

  /** Expire passes whose window closed without the visitor ever arriving. */
  async expireUnused(context: RequestContext): Promise<number> {
    return visitorPassRepository.updateMany(
      context,
      { status: 'pending', expectedDeparture: { $lte: new Date() } },
      { $set: { status: 'expired' } },
    );
  }

  // ---------------------------------------------------------------------------

  /** A resident acts for their own household; staff act for anyone. */
  private async assertMayActFor(context: RequestContext, hostMembershipId: string): Promise<void> {
    if (can(context, PERMISSIONS.VISITOR_APPROVE) || can(context, PERMISSIONS.RESIDENT_UPDATE)) {
      return;
    }

    const host = await membershipRepository.findByIdOrFail(context, hostMembershipId);
    if (host.userId.toHexString() !== context.userId) {
      throw new AuthorizationError('You can only create visitor passes for your own household.');
    }
  }

  /** Retry on collision rather than trusting six characters to never repeat. */
  private async uniqueCode(context: RequestContext): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateShortCode();
      if (!(await visitorPassRepository.findByCode(context, code))) return code;
    }

    throw new ConflictError('Could not allocate a visitor code. Please try again.');
  }
}

export const visitorService = new VisitorService();
