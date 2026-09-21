import { Types } from 'mongoose';
import { BaseRepository, withTransaction } from '@/core/db';
import { events } from '@/core/events';
import { AuthorizationError, ConflictError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { credentialService } from '@/modules/credential';
import { membershipRepository } from '@/modules/membership/repository';
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
