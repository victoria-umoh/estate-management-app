import { Types } from 'mongoose';
import { BaseRepository, allocateReference } from '@/core/db';
import { events } from '@/core/events';
import { ConflictError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { membershipRepository } from '@/modules/membership/repository';
import { EmergencyModel, type EmergencyDoc, type EmergencyType } from './schema';

const log = createLogger('emergency');

class EmergencyRepository extends BaseRepository<EmergencyDoc> {
  constructor() {
    super(EmergencyModel);
  }

  findActive(context: RequestContext): Promise<EmergencyDoc[]> {
    return this.findMany(
      context,
      { status: { $in: ['triggered', 'acknowledged', 'responding'] } },
      { sort: { createdAt: -1 } },
    );
  }
}

export const emergencyRepository = new EmergencyRepository();

export interface TriggerEmergencyInput {
  type: EmergencyType;
  description?: string;
  location?: string;
  coordinates?: { lat: number; lng: number };
  contactPhone?: string;
}

/**
 * Emergencies.
 *
 * The one rule that governs this module: raising an alert must not fail.
 * Everything optional stays optional, nothing blocks on a lookup that could be
 * slow, and the record is written before anything else is attempted.
 */
export class EmergencyService {
  /**
   * Raise an alert.
   *
   * Requires only `emergency.create`, which every resident role holds — a
   * permission check that could refuse someone in trouble would be a design
   * fault, not a security feature.
   */
  async trigger(
    context: RequestContext,
    membershipId: string,
    input: TriggerEmergencyInput,
  ): Promise<EmergencyDoc> {
    assertCan(context, PERMISSIONS.EMERGENCY_CREATE);

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);

    const emergency = await emergencyRepository.create(context, {
      reference: await allocateReference(EmergencyModel, 'reference', 'EMG', context.estateId),
      type: input.type,
      triggeredByMembershipId: new Types.ObjectId(membershipId),
      ...(membership.propertyId ? { propertyId: membership.propertyId } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.coordinates ? { coordinates: input.coordinates } : {}),
      ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
      status: 'triggered',
      notifiedMembershipIds: [],
    });

    // Emitted after the record exists, so a failing notification handler cannot
    // lose the alert itself. The bus isolates handler errors by design.
    events.emit('emergency.triggered', {
      emergencyId: emergency._id.toHexString(),
      estateId: context.estateId,
      type: input.type,
    });

    // Logged at error level deliberately: this should page someone.
    log.error(
      {
        emergencyId: emergency._id.toHexString(),
        reference: emergency.reference,
        type: input.type,
        propertyId: membership.propertyId?.toHexString(),
      },
      'EMERGENCY TRIGGERED',
    );

    await auditService.record(context, {
      action: 'emergency.triggered',
      resource: 'emergency',
      resourceId: emergency._id,
      metadata: { reference: emergency.reference, type: input.type },
    });

    return emergency;
  }

  /**
   * Acknowledge an alert.
   *
   * Records the response time from trigger to acknowledgement — the number an
   * estate is actually judged on. Stored rather than derived, so a later
   * correction to a timestamp cannot quietly improve a past figure.
   */
  async acknowledge(
    context: RequestContext,
    emergencyId: string,
    responderMembershipId: string,
  ): Promise<EmergencyDoc> {
    assertCan(context, PERMISSIONS.EMERGENCY_ACKNOWLEDGE);

    const emergency = await emergencyRepository.findByIdOrFail(context, emergencyId);

    if (emergency.status !== 'triggered') {
      throw new ConflictError(`That emergency has already been ${emergency.status}.`);
    }

    const now = new Date();
    const responseTimeSeconds = Math.round((now.getTime() - emergency.createdAt.getTime()) / 1000);

    const updated = await emergencyRepository.updateById(context, emergencyId, {
      $set: {
        status: 'acknowledged',
        acknowledgedAt: now,
        acknowledgedByMembershipId: new Types.ObjectId(responderMembershipId),
        responseTimeSeconds,
      },
    });

    events.emit('emergency.acknowledged', {
      emergencyId,
      responderId: responderMembershipId,
    });

    await auditService.record(context, {
      action: 'emergency.acknowledged',
      resource: 'emergency',
      resourceId: emergencyId,
      metadata: { reference: emergency.reference, responseTimeSeconds },
    });

    log.info({ emergencyId, responseTimeSeconds }, 'emergency acknowledged');

    return updated;
  }

  async markResponding(context: RequestContext, emergencyId: string): Promise<EmergencyDoc> {
    assertCan(context, PERMISSIONS.EMERGENCY_ACKNOWLEDGE);

    return emergencyRepository.updateById(context, emergencyId, {
      $set: { status: 'responding', respondingAt: new Date() },
    });
  }

  /**
   * Close out an alert.
   *
   * `false-alarm` is a first-class outcome rather than a deletion. A resident
   * who fears being blamed for a false alarm is a resident who hesitates next
   * time, and the hesitation is the real danger.
   */
  async resolve(
    context: RequestContext,
    emergencyId: string,
    responderMembershipId: string,
    input: { outcome: string; falseAlarm?: boolean },
  ): Promise<EmergencyDoc> {
    assertCan(context, PERMISSIONS.EMERGENCY_RESOLVE);

    const emergency = await emergencyRepository.findByIdOrFail(context, emergencyId);

    if (emergency.status === 'resolved' || emergency.status === 'false-alarm') {
      throw new ConflictError('That emergency is already closed.');
    }

    const updated = await emergencyRepository.updateById(context, emergencyId, {
      $set: {
        status: input.falseAlarm ? 'false-alarm' : 'resolved',
        resolvedAt: new Date(),
        resolvedByMembershipId: new Types.ObjectId(responderMembershipId),
        outcome: input.outcome,
      },
    });

    await auditService.record(context, {
      action: 'emergency.resolved',
      resource: 'emergency',
      resourceId: emergencyId,
      metadata: {
        reference: emergency.reference,
        falseAlarm: input.falseAlarm ?? false,
        responseTimeSeconds: emergency.responseTimeSeconds ?? null,
      },
    });

    return updated;
  }

  async listActive(context: RequestContext): Promise<EmergencyDoc[]> {
    assertCan(context, PERMISSIONS.EMERGENCY_VIEW);
    return emergencyRepository.findActive(context);
  }
}

export const emergencyService = new EmergencyService();
