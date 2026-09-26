/**
 * Properties, occupancy and transfer.
 *
 * The property under test throughout is that history survives: relationships
 * end, and when they do the record of them must remain, because gate logs,
 * invoices and disputes all point back to it.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { propertyOccupancyRepository, propertyRepository } from './repository';
import { PropertyModel, PropertyOccupancyModel } from './schema';
import { propertyService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

const OWNER = new mongoose.Types.ObjectId().toHexString();
const NEW_OWNER = new mongoose.Types.ObjectId().toHexString();
const TENANT = new mongoose.Types.ObjectId().toHexString();

function ctx(estateId = ESTATE_A, permissions: string[] = ['*']): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-manager'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const admin = ctx();

beforeEach(async () => {
  await PropertyModel.syncIndexes();
  await PropertyOccupancyModel.syncIndexes();
});

async function makeProperty(unitNumber = '12B') {
  return propertyService.create(admin, {
    unitNumber,
    street: 'Palm Avenue',
    type: 'duplex',
    maxOccupants: 6,
  });
}

describe('creating properties', () => {
  it('registers a property as vacant', async () => {
    const property = await makeProperty();

    expect(property.unitNumber).toBe('12B');
    expect(property.occupancyStatus).toBe('vacant');
    expect(property.currentOccupantCount).toBe(0);
  });

  it('rejects a duplicate unit number within the estate', async () => {
    await makeProperty('12B');
    await expect(makeProperty('12B')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows the same unit number in a different estate', async () => {
    await makeProperty('12B');
    await expect(
      propertyService.create(ctx(ESTATE_B), {
        unitNumber: '12B',
        street: 'Other Road',
        type: 'bungalow',
      }),
    ).resolves.toBeDefined();
  });

  it('requires property.create', async () => {
    await expect(
      propertyService.create(ctx(ESTATE_A, [PERMISSIONS.PROPERTY_VIEW]), {
        unitNumber: '1A',
        street: 'X',
        type: 'duplex',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records creation in the audit trail', async () => {
    await makeProperty();
    expect(await AuditLogModel.countDocuments({ action: 'property.created' })).toBe(1);
  });
});

describe('assigning occupants', () => {
  it('assigns an owner and marks the property owner-occupied', async () => {
    const property = await makeProperty();

    await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: OWNER,
      role: 'owner',
    });

    const updated = await propertyRepository.findByIdOrFail(admin, property._id);
    expect(updated.occupancyStatus).toBe('owner-occupied');
    expect(updated.ownerId?.toHexString()).toBe(OWNER);
  });

  it('assigns a tenant with lease dates and occupant count', async () => {
    const property = await makeProperty();

    const occupancy = await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
      leaseStartDate: new Date('2026-01-01'),
      leaseEndDate: new Date('2026-12-31'),
      occupantCount: 3,
    });

    expect(occupancy.leaseEndDate).toEqual(new Date('2026-12-31'));

    const updated = await propertyRepository.findByIdOrFail(admin, property._id);
    expect(updated.occupancyStatus).toBe('tenant-occupied');
    expect(updated.currentOccupantCount).toBe(3);
  });

  it('rejects a lease ending before it starts', async () => {
    const property = await makeProperty();

    await expect(
      propertyService.assignOccupant(admin, {
        propertyId: property._id.toHexString(),
        membershipId: TENANT,
        role: 'tenant',
        leaseStartDate: new Date('2026-12-31'),
        leaseEndDate: new Date('2026-01-01'),
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects assigning the same person twice to one role', async () => {
    const property = await makeProperty();
    const input = {
      propertyId: property._id.toHexString(),
      membershipId: OWNER,
      role: 'owner' as const,
    };

    await propertyService.assignOccupant(admin, input);
    await expect(propertyService.assignOccupant(admin, input)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  // The replaced tenancy is closed, not removed — invoices and gate logs from
  // that period still refer to it.
  it('closes the previous holder rather than deleting the record', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: NEW_OWNER,
      role: 'owner',
    });

    const history = await propertyOccupancyRepository.findHistory(admin, propertyId);
    expect(history).toHaveLength(2);

    const closed = history.find((entry) => entry.membershipId.toHexString() === OWNER);
    expect(closed?.endedAt).toBeInstanceOf(Date);
    expect(closed?.endReason).toBe('transferred');

    const current = history.find((entry) => entry.endedAt === null);
    expect(current?.membershipId.toHexString()).toBe(NEW_OWNER);
  });

  // Enforced by a partial unique index rather than by application logic, so two
  // concurrent writes cannot both succeed.
  it('permits only one current holder per role', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: NEW_OWNER,
      role: 'owner',
    });

    const open = await PropertyOccupancyModel.countDocuments({
      propertyId: property._id,
      role: 'owner',
      endedAt: null,
    });
    expect(open).toBe(1);
  });

  it('keeps owner, landlord and tenant as independent roles', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: OWNER,
      role: 'landlord',
    });
    await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: TENANT,
      role: 'tenant',
    });

    const occupants = await propertyOccupancyRepository.findCurrentOccupants(admin, propertyId);
    expect(occupants.map((entry) => entry.role).sort()).toEqual(['landlord', 'owner', 'tenant']);
  });
});

describe('ending an occupancy', () => {
  it('closes the record and returns the property to vacant', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    const tenancy = await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: TENANT,
      role: 'tenant',
      occupantCount: 2,
    });

    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'lease-ended');

    const updated = await propertyRepository.findByIdOrFail(admin, propertyId);
    expect(updated.occupancyStatus).toBe('vacant');
    expect(updated.currentOccupantCount).toBe(0);
  });

  it('leaves an owner in place when only the tenant departs', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    const tenancy = await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: TENANT,
      role: 'tenant',
    });

    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'moved-out');

    const updated = await propertyRepository.findByIdOrFail(admin, propertyId);
    expect(updated.occupancyStatus).toBe('owner-occupied');
  });

  it('refuses to end an occupancy twice', async () => {
    const property = await makeProperty();
    const tenancy = await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
    });

    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'lease-ended');
    await expect(
      propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'lease-ended'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('preserves the departed tenant record', async () => {
    const property = await makeProperty();
    const tenancy = await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
    });

    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'moved-out');

    const preserved = await PropertyOccupancyModel.findById(tenancy._id).lean();
    expect(preserved).not.toBeNull();
    expect(preserved?.endReason).toBe('moved-out');
    expect(preserved?.membershipId.toHexString()).toBe(TENANT);
  });
});

describe('transferring ownership', () => {
  it('moves ownership and records both parties', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.transferOwnership(admin, { propertyId, toMembershipId: NEW_OWNER });

    const updated = await propertyRepository.findByIdOrFail(admin, propertyId);
    expect(updated.ownerId?.toHexString()).toBe(NEW_OWNER);

    const entry = await AuditLogModel.findOne({ action: 'property.transferred' }).lean();
    expect(entry?.metadata).toMatchObject({
      fromMembershipId: OWNER,
      toMembershipId: NEW_OWNER,
      unitNumber: '12B',
    });
  });

  // A buyer inherits the property, not the seller's tenancy agreements.
  it('can end sitting tenancies as part of the sale', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: TENANT,
      role: 'tenant',
    });

    await propertyService.transferOwnership(admin, {
      propertyId,
      toMembershipId: NEW_OWNER,
      endExistingTenancies: true,
    });

    const openTenancies = await PropertyOccupancyModel.countDocuments({
      propertyId: property._id,
      role: 'tenant',
      endedAt: null,
    });
    expect(openTenancies).toBe(0);
  });

  it('leaves sitting tenancies intact by default', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.assignOccupant(admin, {
      propertyId,
      membershipId: TENANT,
      role: 'tenant',
    });

    await propertyService.transferOwnership(admin, { propertyId, toMembershipId: NEW_OWNER });

    const openTenancies = await PropertyOccupancyModel.countDocuments({
      propertyId: property._id,
      role: 'tenant',
      endedAt: null,
    });
    expect(openTenancies).toBe(1);
  });

  it('requires property.transfer', async () => {
    const property = await makeProperty();
    await expect(
      propertyService.transferOwnership(ctx(ESTATE_A, [PERMISSIONS.PROPERTY_UPDATE]), {
        propertyId: property._id.toHexString(),
        toMembershipId: NEW_OWNER,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps the full ownership chain', async () => {
    const property = await makeProperty();
    const propertyId = property._id.toHexString();

    await propertyService.assignOccupant(admin, { propertyId, membershipId: OWNER, role: 'owner' });
    await propertyService.transferOwnership(admin, { propertyId, toMembershipId: NEW_OWNER });
    await propertyService.transferOwnership(admin, { propertyId, toMembershipId: TENANT });

    const history = await propertyService.history(admin, propertyId);
    const owners = history.filter((entry) => entry.role === 'owner');

    expect(owners).toHaveLength(3);
    expect(owners.filter((entry) => entry.endedAt === null)).toHaveLength(1);
  });
});

describe('lease expiry', () => {
  it('finds tenancies expiring within a window', async () => {
    const property = await makeProperty();

    await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
      leaseEndDate: new Date(Date.now() + 10 * 86_400_000),
    });

    const soon = await propertyOccupancyRepository.findExpiringLeases(admin, 30);
    expect(soon).toHaveLength(1);

    const sooner = await propertyOccupancyRepository.findExpiringLeases(admin, 5);
    expect(sooner).toHaveLength(0);
  });

  it('ignores tenancies that have already ended', async () => {
    const property = await makeProperty();
    const tenancy = await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
      leaseEndDate: new Date(Date.now() + 5 * 86_400_000),
    });

    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'moved-out');
    expect(await propertyOccupancyRepository.findExpiringLeases(admin, 30)).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('hides another estate properties and occupancy', async () => {
    const property = await makeProperty();
    const foreign = ctx(ESTATE_B);

    expect(await propertyRepository.findById(foreign, property._id)).toBeNull();
    await expect(
      propertyService.history(foreign, property._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      propertyService.transferOwnership(foreign, {
        propertyId: property._id.toHexString(),
        toMembershipId: NEW_OWNER,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

/**
 * The tenancy lifecycle: invite -> approve -> renew -> exit.
 *
 * The property under test is that each step is recorded rather than replaced.
 * Renewal is the one that matters most: if the old window were overwritten,
 * "was this person entitled to be here in March?" would have no answer.
 */
describe('tenancy lifecycle', () => {
  const TENANCY_STAFF = [
    PERMISSIONS.TENANT_CREATE,
    PERMISSIONS.TENANT_VIEW,
    PERMISSIONS.TENANT_APPROVE,
    PERMISSIONS.TENANT_RENEW,
    PERMISSIONS.TENANT_EXIT,
  ];

  async function makeTenancy(overrides: { leaseEndDate?: Date } = {}) {
    const property = await makeProperty(`T${Math.floor(Math.random() * 10000)}`);

    return propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
      leaseStartDate: new Date('2026-01-01'),
      leaseEndDate: overrides.leaseEndDate ?? new Date('2026-12-31'),
      occupantCount: 2,
    });
  }

  it('records a new tenancy as unapproved', async () => {
    const tenancy = await makeTenancy();
    expect(tenancy.approvedAt ?? null).toBeNull();
  });

  it('approves a tenancy and stamps who signed it off', async () => {
    const tenancy = await makeTenancy();
    const approver = ctx(ESTATE_A, TENANCY_STAFF);

    const approved = await propertyService.approveTenancy(approver, tenancy._id.toHexString());

    expect(approved.approvedAt).toBeInstanceOf(Date);
    expect(approved.approvedBy?.toHexString()).toBe(approver.userId);
  });

  it('refuses to approve the same tenancy twice', async () => {
    const tenancy = await makeTenancy();
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());

    await expect(
      propertyService.approveTenancy(admin, tenancy._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to approve an ended tenancy', async () => {
    const tenancy = await makeTenancy();
    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'moved-out');

    await expect(
      propertyService.approveTenancy(admin, tenancy._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('requires tenant.approve', async () => {
    const tenancy = await makeTenancy();

    await expect(
      propertyService.approveTenancy(
        ctx(ESTATE_A, [PERMISSIONS.TENANT_VIEW]),
        tenancy._id.toHexString(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps the superseded window when a tenancy is renewed', async () => {
    const tenancy = await makeTenancy({ leaseEndDate: new Date('2026-12-31') });
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());

    const renewed = await propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
      leaseEndDate: new Date('2027-12-31'),
    });

    expect(renewed.leaseEndDate).toEqual(new Date('2027-12-31'));
    // The window it replaced is still on the record, which is the whole point.
    expect(renewed.previousLeaseTerms).toHaveLength(1);
    expect(renewed.previousLeaseTerms[0]?.leaseStartDate).toEqual(new Date('2026-01-01'));
    expect(renewed.previousLeaseTerms[0]?.leaseEndDate).toEqual(new Date('2026-12-31'));
  });

  it('abuts the new window to the end of the old one by default', async () => {
    const tenancy = await makeTenancy({ leaseEndDate: new Date('2026-12-31') });
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());

    const renewed = await propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
      leaseEndDate: new Date('2027-12-31'),
    });

    expect(renewed.leaseStartDate).toEqual(new Date('2026-12-31'));
  });

  it('accumulates every term across repeated renewals', async () => {
    const tenancy = await makeTenancy({ leaseEndDate: new Date('2026-12-31') });
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());

    await propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
      leaseEndDate: new Date('2027-12-31'),
    });
    const second = await propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
      leaseEndDate: new Date('2028-12-31'),
    });

    expect(second.previousLeaseTerms.map((term) => term.leaseEndDate)).toEqual([
      new Date('2026-12-31'),
      new Date('2027-12-31'),
    ]);
  });

  it('refuses a renewal that does not extend the lease', async () => {
    const tenancy = await makeTenancy({ leaseEndDate: new Date('2026-12-31') });
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());

    await expect(
      propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
        leaseEndDate: new Date('2026-06-30'),
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses to renew a tenancy that was never approved', async () => {
    const tenancy = await makeTenancy();

    await expect(
      propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
        leaseEndDate: new Date('2028-12-31'),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to renew an ended tenancy', async () => {
    const tenancy = await makeTenancy();
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());
    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'lease-ended');

    await expect(
      propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
        leaseEndDate: new Date('2028-12-31'),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('records approval and renewal in the audit trail', async () => {
    const tenancy = await makeTenancy();
    await propertyService.approveTenancy(admin, tenancy._id.toHexString());
    await propertyService.renewTenancy(admin, tenancy._id.toHexString(), {
      leaseEndDate: new Date('2028-12-31'),
    });

    expect(await AuditLogModel.countDocuments({ action: 'property.tenancy_approved' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'property.tenancy_renewed' })).toBe(1);
  });

  it('will not treat an ownership record as a tenancy', async () => {
    const property = await makeProperty('OWN1');
    const ownership = await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: OWNER,
      role: 'owner',
    });

    await expect(
      propertyService.approveTenancy(admin, ownership._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('treats a tenancy in another estate as not found', async () => {
    const tenancy = await makeTenancy();

    await expect(
      propertyService.tenancy(ctx(ESTATE_B), tenancy._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists tenancies awaiting approval separately from approved ones', async () => {
    const pending = await makeTenancy();
    const approved = await makeTenancy();
    await propertyService.approveTenancy(admin, approved._id.toHexString());

    const awaiting = await propertyService.tenancies(admin, { state: 'pending' });
    expect(awaiting.items.map((item) => item._id.toHexString())).toEqual([
      pending._id.toHexString(),
    ]);

    const live = await propertyService.tenancies(admin, { state: 'approved' });
    expect(live.items.map((item) => item._id.toHexString())).toEqual([approved._id.toHexString()]);
  });

  it('requires tenant.view to list tenancies', async () => {
    await expect(
      propertyService.tenancies(ctx(ESTATE_A, [PERMISSIONS.PROPERTY_VIEW])),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('deleting a property', () => {
  it('soft deletes, leaving the row retrievable', async () => {
    const property = await makeProperty('DEL1');

    await propertyService.remove(admin, property._id.toHexString(), 'Demolished');

    await expect(propertyRepository.findByIdOrFail(admin, property._id)).rejects.toMatchObject({
      statusCode: 404,
    });

    const retained = await propertyRepository.findById(admin, property._id, {
      includeDeleted: true,
    });
    expect(retained?.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses while anyone still occupies it, and says who', async () => {
    const property = await makeProperty('DEL2');
    await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
    });

    await expect(
      propertyService.remove(admin, property._id.toHexString(), 'Demolished'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('tenant'),
    });
  });

  it('allows the delete once the occupancy has ended', async () => {
    const property = await makeProperty('DEL3');
    const tenancy = await propertyService.assignOccupant(admin, {
      propertyId: property._id.toHexString(),
      membershipId: TENANT,
      role: 'tenant',
    });
    await propertyService.endOccupancy(admin, tenancy._id.toHexString(), 'moved-out');

    await expect(
      propertyService.remove(admin, property._id.toHexString(), 'Demolished'),
    ).resolves.toBeUndefined();
  });

  it('requires property.delete', async () => {
    const property = await makeProperty('DEL4');

    await expect(
      propertyService.remove(
        ctx(ESTATE_A, [PERMISSIONS.PROPERTY_UPDATE]),
        property._id.toHexString(),
        'Demolished',
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the reason in the audit trail', async () => {
    const property = await makeProperty('DEL5');
    await propertyService.remove(admin, property._id.toHexString(), 'Merged into 12A');

    const entry = await AuditLogModel.findOne({ action: 'property.deleted' }).lean();
    expect(entry?.reason).toBe('Merged into 12A');
  });

  it('frees the unit number for reuse', async () => {
    const property = await makeProperty('REUSE');
    await propertyService.remove(admin, property._id.toHexString(), 'Renumbered');

    await expect(makeProperty('REUSE')).resolves.toBeDefined();
  });
});
