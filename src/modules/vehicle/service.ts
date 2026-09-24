import { Types } from 'mongoose';
import { BaseRepository, withTransaction } from '@/core/db';
import { events } from '@/core/events';
import { AuthorizationError, ConflictError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { credentialRepository, credentialService } from '@/modules/credential';
import { membershipRepository } from '@/modules/membership/repository';
import { movementRepository } from '@/modules/movement';
import { VehicleModel, normalisePlate, type VehicleDoc } from './schema';

const log = createLogger('vehicle');

class VehicleRepository extends BaseRepository<VehicleDoc> {
  constructor() {
    super(VehicleModel);
  }

  findByPlate(context: RequestContext, plate: string): Promise<VehicleDoc | null> {
    return this.findOne(context, { plateNormalised: normalisePlate(plate) });
  }

  findForOwner(context: RequestContext, ownerMembershipId: string): Promise<VehicleDoc[]> {
    return this.findMany(context, {
      ownerMembershipId: new Types.ObjectId(ownerMembershipId),
      status: { $ne: 'removed' },
    });
  }
}

export const vehicleRepository = new VehicleRepository();

export interface RegisterVehicleInput {
  ownerMembershipId: string;
  plateNumber: string;
  make: string;
  model: string;
  colour: string;
  year?: number;
  type?: VehicleDoc['type'];
  driverName?: string;
  driverPhone?: string;
  insuranceProvider?: string;
  insuranceExpiryDate?: Date;
}

export interface UpdateVehicleInput {
  plateNumber?: string;
  make?: string;
  model?: string;
  colour?: string;
  year?: number | null;
  type?: VehicleDoc['type'];
  driverName?: string | null;
  driverPhone?: string | null;
  insuranceProvider?: string | null;
  insuranceExpiryDate?: Date | null;
}

/** Amendable free-text fields, trimmed uniformly rather than field by field. */
const TEXT_FIELDS = [
  'make',
  'model',
  'colour',
  'driverName',
  'driverPhone',
  'insuranceProvider',
] as const satisfies ReadonlyArray<keyof UpdateVehicleInput>;

export class VehicleService {
  async register(context: RequestContext, input: RegisterVehicleInput): Promise<VehicleDoc> {
    assertCan(context, PERMISSIONS.VEHICLE_CREATE);
    await this.assertMayManage(context, input.ownerMembershipId);

    const normalised = normalisePlate(input.plateNumber);

    const existing = await vehicleRepository.findByPlate(context, normalised);
    if (existing) {
      // Names the plate, not the owner: confirming who holds a registration
      // would let anyone enumerate residents by trying plates.
      throw new ConflictError(`A vehicle with plate ${input.plateNumber} is already registered.`);
    }

    const owner = await membershipRepository.findByIdOrFail(context, input.ownerMembershipId);

    return withTransaction(async (session) => {
      const vehicle = await vehicleRepository.create(
        context,
        {
          plateNumber: input.plateNumber.trim().toUpperCase(),
          plateNormalised: normalised,
          make: input.make.trim(),
          model: input.model.trim(),
          colour: input.colour.trim(),
          ...(input.year ? { year: input.year } : {}),
          type: input.type ?? 'car',
          ownerMembershipId: new Types.ObjectId(input.ownerMembershipId),
          ...(owner.propertyId ? { propertyId: owner.propertyId } : {}),
          ...(input.driverName ? { driverName: input.driverName } : {}),
          ...(input.driverPhone ? { driverPhone: input.driverPhone } : {}),
          ...(input.insuranceProvider ? { insuranceProvider: input.insuranceProvider } : {}),
          ...(input.insuranceExpiryDate ? { insuranceExpiryDate: input.insuranceExpiryDate } : {}),
          documentIds: [],
          // Pending until verified: an unverified vehicle should not open a gate.
          status: 'pending',
        },
        { session },
      );

      await auditService.record(context, {
        action: 'vehicle.registered',
        resource: 'vehicle',
        resourceId: vehicle._id,
        after: { plateNumber: vehicle.plateNumber, make: vehicle.make, model: vehicle.model },
        session,
      });

      events.emit('vehicle.registered', {
        vehicleId: vehicle._id.toHexString(),
        estateId: context.estateId,
      });

      return vehicle;
    });
  }

  /**
   * Verify a vehicle and issue its gate credential.
   *
   * The credential is created here rather than at registration, because until
   * someone has checked the papers the vehicle has no business opening a gate.
   */
  async verify(
    context: RequestContext,
    vehicleId: string,
    ownerLabel: string,
    unitNumber?: string,
  ): Promise<{ token: string; vehicle: VehicleDoc }> {
    assertCan(context, PERMISSIONS.VEHICLE_VERIFY);

    const vehicle = await vehicleRepository.findByIdOrFail(context, vehicleId);

    if (vehicle.status === 'blacklisted') {
      throw new ConflictError('That vehicle is blacklisted and cannot be verified.');
    }

    const updated = await vehicleRepository.updateById(context, vehicleId, {
      $set: {
        status: 'active',
        verifiedAt: new Date(),
        verifiedBy: new Types.ObjectId(context.userId),
      },
    });

    const { token } = await credentialService.issue(context, {
      subject: 'vehicle',
      subjectId: vehicleId,
      display: {
        // The plate is what the officer matches against the bumper.
        primaryLabel: vehicle.plateNumber,
        secondaryLabel: `${vehicle.colour} ${vehicle.make} ${vehicle.model}`,
        unitNumber: unitNumber ?? null,
        category: ownerLabel,
        photoUrl: vehicle.photoUrl ?? null,
      },
    });

    await auditService.record(context, {
      action: 'vehicle.verified',
      resource: 'vehicle',
      resourceId: vehicleId,
      metadata: { plateNumber: vehicle.plateNumber },
    });

    return { token, vehicle: updated };
  }

  /**
   * Amend a vehicle's details.
   *
   * The plate is the exception to "straightforward". At the barrier the plate
   * IS the vehicle: it is what the officer reads off the bumper and what the
   * credential displays. Changing it while an active credential still shows the
   * old one leaves the gate matching a car that no longer exists — so the
   * credential is reissued in the same call, which supersedes and uncaches the
   * stale one. The new token comes back exactly once, as it does from `verify`.
   */
  async update(
    context: RequestContext,
    vehicleId: string,
    input: UpdateVehicleInput,
  ): Promise<{ vehicle: VehicleDoc; token?: string }> {
    assertCan(context, PERMISSIONS.VEHICLE_UPDATE);

    const vehicle = await vehicleRepository.findByIdOrFail(context, vehicleId);
    await this.assertMayManage(context, vehicle.ownerMembershipId.toHexString());

    const changes: Record<string, unknown> = {};
    for (const field of TEXT_FIELDS) {
      if (input[field] !== undefined) changes[field] = input[field]?.trim() ?? null;
    }
    if (input.year !== undefined) changes.year = input.year;
    if (input.type !== undefined) changes.type = input.type;
    if (input.insuranceExpiryDate !== undefined) {
      changes.insuranceExpiryDate = input.insuranceExpiryDate;
    }

    const normalised = input.plateNumber ? normalisePlate(input.plateNumber) : null;
    const plateChanged = normalised !== null && normalised !== vehicle.plateNormalised;

    if (plateChanged) {
      const clash = await vehicleRepository.findByPlate(context, normalised);
      if (clash) {
        throw new ConflictError(`A vehicle with plate ${input.plateNumber} is already registered.`);
      }

      changes.plateNumber = input.plateNumber!.trim().toUpperCase();
      changes.plateNormalised = normalised;
    }

    if (Object.keys(changes).length === 0) return { vehicle };

    const updated = await vehicleRepository.updateById(context, vehicleId, { $set: changes });

    // Reissued rather than merely resynced: the plate is the credential's
    // identity, and a new identity deserves a new token rather than an old one
    // quietly relabelled.
    let token: string | undefined;
    const existing = plateChanged
      ? await credentialRepository.findActiveFor(context, 'vehicle', vehicleId)
      : null;

    if (existing) {
      const issued = await credentialService.issue(context, {
        subject: 'vehicle',
        subjectId: vehicleId,
        display: {
          ...existing.display,
          primaryLabel: updated.plateNumber,
          secondaryLabel: `${updated.colour} ${updated.make} ${updated.model}`,
        },
        ...(existing.validUntil ? { validUntil: existing.validUntil } : {}),
      });
      token = issued.token;
    } else if (!plateChanged) {
      // Same plate, possibly a new colour or model: the officer's second line
      // of description would otherwise stay wrong until the next reissue.
      await credentialService.syncDisplay(context, 'vehicle', vehicleId, {
        secondaryLabel: `${updated.colour} ${updated.make} ${updated.model}`,
      });
    }

    await auditService.record(context, {
      action: 'vehicle.updated',
      resource: 'vehicle',
      resourceId: vehicleId,
      before: { plateNumber: vehicle.plateNumber, colour: vehicle.colour, model: vehicle.model },
      after: { plateNumber: updated.plateNumber, colour: updated.colour, model: updated.model },
      metadata: { plateChanged, credentialReissued: Boolean(token) },
    });

    return { vehicle: updated, ...(token ? { token } : {}) };
  }

  /**
   * Remove a vehicle from the register.
   *
   * A soft delete: movements name this vehicle, and a hard delete would leave
   * the gate log pointing at nothing. Refused while the vehicle is inside the
   * estate, because deleting it revokes the credential it needs to get back
   * out — and the officer at the barrier is then arguing with a driver about a
   * record that no longer exists.
   */
  async remove(context: RequestContext, vehicleId: string, reason: string): Promise<void> {
    assertCan(context, PERMISSIONS.VEHICLE_DELETE);

    const vehicle = await vehicleRepository.findByIdOrFail(context, vehicleId);

    const last = await movementRepository.lastFor(context, 'vehicle', vehicleId);
    if (last?.direction === 'in') {
      throw new ConflictError(
        `${vehicle.plateNumber} is currently inside the estate (entered ${last.occurredAt.toISOString()}). Record its exit before removing it.`,
      );
    }

    const credential = await credentialRepository.findActiveFor(context, 'vehicle', vehicleId);
    if (credential) {
      await credentialService.revoke(
        context,
        credential._id.toHexString(),
        `vehicle removed: ${reason}`,
      );
    }

    // Status as well as the soft-delete marker: anything reading by status —
    // the owner's own list, the gate's plate lookup — must agree with the
    // register, not just the queries that exclude deleted rows.
    await vehicleRepository.updateById(context, vehicleId, { $set: { status: 'removed' } });
    await vehicleRepository.softDelete(context, vehicleId);

    await auditService.record(context, {
      action: 'vehicle.deleted',
      resource: 'vehicle',
      resourceId: vehicleId,
      reason,
      before: { plateNumber: vehicle.plateNumber, status: vehicle.status },
      metadata: { credentialRevoked: Boolean(credential) },
    });

    log.info({ vehicleId, plate: vehicle.plateNumber }, 'vehicle removed from the register');
  }

  /**
   * Blacklist or clear a vehicle.
   *
   * Blocks the credential in the same operation. Updating only the vehicle row
   * would leave the gate admitting it, because the gate reads credentials, not
   * vehicles.
   */
  async setBlacklist(
    context: RequestContext,
    vehicleId: string,
    blacklisted: boolean,
    reason?: string,
  ): Promise<VehicleDoc> {
    assertCan(context, PERMISSIONS.VEHICLE_BLACKLIST);

    const vehicle = await vehicleRepository.findByIdOrFail(context, vehicleId);

    const updated = await vehicleRepository.updateById(context, vehicleId, {
      $set: {
        status: blacklisted ? 'blacklisted' : 'active',
        blacklistReason: blacklisted ? (reason ?? 'Not specified') : null,
        blacklistedAt: blacklisted ? new Date() : null,
        blacklistedBy: blacklisted ? new Types.ObjectId(context.userId) : null,
      },
    });

    await credentialService.setBlacklisted(context, 'vehicle', vehicleId, blacklisted, reason);

    await auditService.record(context, {
      action: blacklisted ? 'vehicle.blacklisted' : 'vehicle.blacklist_cleared',
      resource: 'vehicle',
      resourceId: vehicleId,
      metadata: { plateNumber: vehicle.plateNumber, ...(reason ? { reason } : {}) },
    });

    if (blacklisted) {
      events.emit('vehicle.blacklisted', {
        vehicleId,
        estateId: context.estateId,
        reason: reason ?? 'Not specified',
      });
      log.warn({ vehicleId, plate: vehicle.plateNumber }, 'vehicle blacklisted');
    }

    return updated;
  }

  /**
   * Plate lookup for the gate.
   *
   * The fallback when a QR will not scan — a dirty windscreen, a cracked
   * screen, a visitor who never received their pass. Returns only what the
   * officer needs to decide.
   */
  async lookupByPlate(
    context: RequestContext,
    plate: string,
  ): Promise<{
    found: boolean;
    plateNumber?: string;
    description?: string;
    unitNumber?: string | null;
    status?: VehicleDoc['status'];
    blacklisted?: boolean;
    blacklistReason?: string | null;
  }> {
    assertCan(context, PERMISSIONS.VEHICLE_VIEW);

    const vehicle = await vehicleRepository.findByPlate(context, plate);
    if (!vehicle) return { found: false };

    return {
      found: true,
      plateNumber: vehicle.plateNumber,
      description: `${vehicle.colour} ${vehicle.make} ${vehicle.model}`,
      unitNumber: null,
      status: vehicle.status,
      blacklisted: vehicle.status === 'blacklisted',
      blacklistReason: vehicle.blacklistReason ?? null,
    };
  }

  /** A resident manages their own vehicles; staff manage any. */
  private async assertMayManage(context: RequestContext, ownerMembershipId: string): Promise<void> {
    if (can(context, PERMISSIONS.VEHICLE_VERIFY) || can(context, PERMISSIONS.RESIDENT_UPDATE)) {
      return;
    }

    const owner = await membershipRepository.findByIdOrFail(context, ownerMembershipId);
    if (owner.userId.toHexString() !== context.userId) {
      throw new AuthorizationError('You can only register vehicles for yourself.');
    }
  }
}

export const vehicleService = new VehicleService();
