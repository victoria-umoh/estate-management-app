import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { verifyScan } from '@/modules/credential';
import { MembershipModel } from '@/modules/membership/schema';
import { MovementModel } from '@/modules/movement';
import { UserModel } from '@/modules/user/schema';
import { VehicleModel, normalisePlate } from './schema';
import { vehicleRepository, vehicleService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

let ownerUserId: string;
let ownerMembershipId: string;

function ctx(userId: string, permissions: string[], estateId = ESTATE_A): RequestContext {
  return {
    userId,
    estateId,
    roles: ['homeowner'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const RESIDENT = [PERMISSIONS.VEHICLE_VIEW, PERMISSIONS.VEHICLE_CREATE];
const STAFF = [...RESIDENT, PERMISSIONS.VEHICLE_VERIFY, PERMISSIONS.VEHICLE_BLACKLIST];

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());
  await VehicleModel.syncIndexes();

  const email = `o${Math.random().toString(36).slice(2)}@example.com`;
  const user = await UserModel.create({
    firstName: 'Ada',
    lastName: 'Okonkwo',
    email,
    phone: `+23480${Math.floor(Math.random() * 100000000)}`,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(`${Math.random()}`, 'phone'),
    passwordHash: 'x',
    status: 'active',
  });
  ownerUserId = user._id.toHexString();

  const membership = await MembershipModel.create({
    estateId: new mongoose.Types.ObjectId(ESTATE_A),
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });
  ownerMembershipId = membership._id.toHexString();
});

afterEach(() => setCache(undefined));

const owner = () => ctx(ownerUserId, RESIDENT);
const staff = () => ctx(new mongoose.Types.ObjectId().toHexString(), STAFF);

const car = {
  plateNumber: 'ABC-123-XY',
  make: 'Toyota',
  model: 'Corolla',
  colour: 'Silver',
  type: 'car' as const,
};

describe('plate normalisation', () => {
  // An officer types what is on the bumper, with whatever spacing they see.
  it('collapses formatting differences', () => {
    expect(normalisePlate('abc-123 xy')).toBe('ABC123XY');
    expect(normalisePlate('ABC 123 XY')).toBe('ABC123XY');
    expect(normalisePlate('abc123xy')).toBe('ABC123XY');
  });
});

describe('registration', () => {
  it('registers a vehicle as pending', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });

    // Pending, not active: until someone checks the papers it has no business
    // opening a gate.
    expect(vehicle.status).toBe('pending');
    expect(vehicle.plateNormalised).toBe('ABC123XY');
  });

  it('rejects a duplicate plate however it is spelled', async () => {
    await vehicleService.register(owner(), { ownerMembershipId, ...car });

    await expect(
      vehicleService.register(owner(), { ownerMembershipId, ...car, plateNumber: 'abc 123 xy' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // Confirming who holds a registration would let anyone enumerate residents by
  // trying plates.
  it('does not name the existing owner in the conflict', async () => {
    await vehicleService.register(owner(), { ownerMembershipId, ...car });

    const message = await vehicleService
      .register(staff(), { ownerMembershipId, ...car })
      .then(() => '')
      .catch((error: Error) => error.message);

    expect(message).toContain('ABC-123-XY');
    expect(message).not.toContain('Ada');
  });

  it('allows the same plate in a different estate', async () => {
    await vehicleService.register(owner(), { ownerMembershipId, ...car });

    const otherMembership = await MembershipModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_B),
      userId: new mongoose.Types.ObjectId(),
      category: 'homeowner',
      status: 'active',
      roleIds: [],
    });

    await expect(
      vehicleService.register(ctx(new mongoose.Types.ObjectId().toHexString(), STAFF, ESTATE_B), {
        ownerMembershipId: otherMembership._id.toHexString(),
        ...car,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a resident registering for someone else', async () => {
    const other = await MembershipModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      userId: new mongoose.Types.ObjectId(),
      category: 'tenant',
      status: 'active',
      roleIds: [],
    });

    await expect(
      vehicleService.register(owner(), {
        ownerMembershipId: other._id.toHexString(),
        ...car,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('verification', () => {
  it('activates the vehicle and issues a working gate credential', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });

    const { token, vehicle: verified } = await vehicleService.verify(
      staff(),
      vehicle._id.toHexString(),
      'Homeowner',
      '12B',
    );

    expect(verified.status).toBe('active');

    const scan = await verifyScan(token, ESTATE_A);
    expect(scan.admitted).toBe(true);
    // The plate is what the officer matches against the bumper.
    expect(scan.credential?.display.primaryLabel).toBe('ABC-123-XY');
    expect(scan.credential?.display.secondaryLabel).toBe('Silver Toyota Corolla');
    expect(scan.credential?.display.unitNumber).toBe('12B');
  });

  it('requires vehicle.verify', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await expect(
      vehicleService.verify(owner(), vehicle._id.toHexString(), 'Homeowner'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses to verify a blacklisted vehicle', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.verify(staff(), vehicle._id.toHexString(), 'Homeowner');
    await vehicleService.setBlacklist(staff(), vehicle._id.toHexString(), true, 'Reported stolen');

    await expect(
      vehicleService.verify(staff(), vehicle._id.toHexString(), 'Homeowner'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('blacklisting', () => {
  // Updating only the vehicle row would leave the gate admitting it, because
  // the gate reads credentials, not vehicles.
  it('blocks the credential in the same operation', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const { token } = await vehicleService.verify(staff(), vehicle._id.toHexString(), 'Homeowner');

    expect((await verifyScan(token, ESTATE_A)).admitted).toBe(true);

    await vehicleService.setBlacklist(staff(), vehicle._id.toHexString(), true, 'Reported stolen');

    const scan = await verifyScan(token, ESTATE_A);
    expect(scan.admitted).toBe(false);
    expect(scan.reason).toBe('blacklisted');
    expect(scan.message).toContain('DO NOT ADMIT');
  });

  it('restores access when the block is lifted', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const { token } = await vehicleService.verify(staff(), vehicle._id.toHexString(), 'Homeowner');

    await vehicleService.setBlacklist(staff(), vehicle._id.toHexString(), true, 'Mistake');
    await vehicleService.setBlacklist(staff(), vehicle._id.toHexString(), false);

    expect((await verifyScan(token, ESTATE_A)).admitted).toBe(true);
  });

  it('requires vehicle.blacklist', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await expect(
      vehicleService.setBlacklist(owner(), vehicle._id.toHexString(), true),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the block in the audit trail', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.setBlacklist(staff(), vehicle._id.toHexString(), true, 'Reported stolen');

    const entry = await AuditLogModel.findOne({ action: 'vehicle.blacklisted' }).lean();
    expect(entry?.metadata).toMatchObject({ plateNumber: 'ABC-123-XY', reason: 'Reported stolen' });
  });
});

describe('plate lookup at the gate', () => {
  it('finds a vehicle by any spelling of its plate', async () => {
    await vehicleService.register(owner(), { ownerMembershipId, ...car });

    const result = await vehicleService.lookupByPlate(staff(), 'abc 123 xy');
    expect(result.found).toBe(true);
    expect(result.description).toBe('Silver Toyota Corolla');
  });

  it('reports an unknown plate without error', async () => {
    expect(await vehicleService.lookupByPlate(staff(), 'ZZZ-999-ZZ')).toEqual({ found: false });
  });

  it('flags a blacklisted vehicle with its reason', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.setBlacklist(staff(), vehicle._id.toHexString(), true, 'Reported stolen');

    const result = await vehicleService.lookupByPlate(staff(), 'ABC-123-XY');
    expect(result.blacklisted).toBe(true);
    expect(result.blacklistReason).toBe('Reported stolen');
  });

  it('cannot see another estate vehicles', async () => {
    await vehicleService.register(owner(), { ownerMembershipId, ...car });

    const foreign = ctx(new mongoose.Types.ObjectId().toHexString(), STAFF, ESTATE_B);
    expect(await vehicleService.lookupByPlate(foreign, 'ABC-123-XY')).toEqual({ found: false });
  });
});

describe('owner listing', () => {
  it('lists an owner vehicles, excluding removed ones', async () => {
    await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const second = await vehicleService.register(owner(), {
      ownerMembershipId,
      ...car,
      plateNumber: 'XYZ-789-AB',
    });

    await VehicleModel.updateOne({ _id: second._id }, { $set: { status: 'removed' } });

    const vehicles = await vehicleRepository.findForOwner(owner(), ownerMembershipId);
    expect(vehicles).toHaveLength(1);
  });
});

/**
 * Amending a vehicle.
 *
 * The plate is the thing under test. At the barrier the plate IS the vehicle,
 * so changing it while an active credential still shows the old one leaves the
 * gate matching a car that no longer exists.
 */
describe('updating a vehicle', () => {
  const editor = () => ctx(ownerUserId, [...RESIDENT, PERMISSIONS.VEHICLE_UPDATE]);

  it('amends description fields', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });

    const { vehicle } = await vehicleService.update(editor(), registered._id.toHexString(), {
      colour: 'Black',
      driverName: 'Chidi Eze',
    });

    expect(vehicle.colour).toBe('Black');
    expect(vehicle.driverName).toBe('Chidi Eze');
  });

  it('reissues the credential when the plate changes', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const { token: original } = await vehicleService.verify(
      staff(),
      registered._id.toHexString(),
      'Homeowner',
      '12B',
    );

    const { vehicle, token } = await vehicleService.update(
      editor(),
      registered._id.toHexString(),
      { plateNumber: 'XYZ-789-AB' },
    );

    expect(vehicle.plateNumber).toBe('XYZ-789-AB');
    expect(token).toBeDefined();

    // The stale pass must stop working the moment the new one exists.
    expect((await verifyScan(original, ESTATE_A)).admitted).toBe(false);

    const rescan = await verifyScan(token!, ESTATE_A);
    expect(rescan.admitted).toBe(true);
    expect(rescan.credential?.display.primaryLabel).toBe('XYZ-789-AB');
  });

  it('leaves the credential alone when the plate is unchanged', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const { token: original } = await vehicleService.verify(
      staff(),
      registered._id.toHexString(),
      'Homeowner',
    );

    const { token } = await vehicleService.update(editor(), registered._id.toHexString(), {
      colour: 'Black',
    });

    expect(token).toBeUndefined();
    expect((await verifyScan(original, ESTATE_A)).admitted).toBe(true);
  });

  it('refuses a plate already registered to another vehicle', async () => {
    const first = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.register(owner(), {
      ownerMembershipId,
      ...car,
      plateNumber: 'XYZ-789-AB',
    });

    await expect(
      vehicleService.update(editor(), first._id.toHexString(), { plateNumber: 'XYZ-789-AB' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('accepts a reformatting of the same plate without reissuing', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.verify(staff(), registered._id.toHexString(), 'Homeowner');

    const { token } = await vehicleService.update(editor(), registered._id.toHexString(), {
      plateNumber: 'abc 123 xy',
    });

    expect(token).toBeUndefined();
  });

  it('requires vehicle.update', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });

    await expect(
      vehicleService.update(owner(), registered._id.toHexString(), { colour: 'Black' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('treats a vehicle in another estate as not found', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const foreign = ctx(ownerUserId, [...RESIDENT, PERMISSIONS.VEHICLE_UPDATE], ESTATE_B);

    await expect(
      vehicleService.update(foreign, registered._id.toHexString(), { colour: 'Black' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records the amendment in the audit trail', async () => {
    const registered = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.update(editor(), registered._id.toHexString(), { colour: 'Black' });

    expect(await AuditLogModel.countDocuments({ action: 'vehicle.updated' })).toBe(1);
  });
});

describe('deleting a vehicle', () => {
  const remover = () => ctx(ownerUserId, [...STAFF, PERMISSIONS.VEHICLE_DELETE]);

  async function recordMovement(direction: 'in' | 'out', vehicleId: string) {
    await MovementModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      gateId: new mongoose.Types.ObjectId(),
      officerId: new mongoose.Types.ObjectId(),
      direction,
      subject: 'vehicle',
      subjectId: new mongoose.Types.ObjectId(vehicleId),
      subjectLabel: 'ABC-123-XY',
      admitted: true,
      method: 'qr',
      occurredAt: new Date(),
    });
  }

  it('soft deletes and marks the vehicle removed', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });

    await vehicleService.remove(remover(), vehicle._id.toHexString(), 'Sold');

    const row = await VehicleModel.findById(vehicle._id).lean();
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.status).toBe('removed');
  });

  it('revokes the credential so the plate stops opening the gate', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    const { token } = await vehicleService.verify(staff(), vehicle._id.toHexString(), 'Homeowner');

    await vehicleService.remove(remover(), vehicle._id.toHexString(), 'Sold');

    expect((await verifyScan(token, ESTATE_A)).admitted).toBe(false);
  });

  it('refuses while the vehicle is inside the estate', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await recordMovement('in', vehicle._id.toHexString());

    await expect(
      vehicleService.remove(remover(), vehicle._id.toHexString(), 'Sold'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('inside the estate'),
    });
  });

  it('allows the delete once the vehicle has left', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await recordMovement('in', vehicle._id.toHexString());
    await recordMovement('out', vehicle._id.toHexString());

    await expect(
      vehicleService.remove(remover(), vehicle._id.toHexString(), 'Sold'),
    ).resolves.toBeUndefined();
  });

  it('requires vehicle.delete', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });

    await expect(
      vehicleService.remove(staff(), vehicle._id.toHexString(), 'Sold'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the reason in the audit trail', async () => {
    const vehicle = await vehicleService.register(owner(), { ownerMembershipId, ...car });
    await vehicleService.remove(remover(), vehicle._id.toHexString(), 'Sold to a third party');

    const entry = await AuditLogModel.findOne({ action: 'vehicle.deleted' }).lean();
    expect(entry?.reason).toBe('Sold to a third party');
  });
});
