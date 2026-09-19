import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { DependantModel } from './schema';
import { householdService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

let guardianUserId: string;
let guardianMembershipId: string;
let neighbourMembershipId: string;

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

const RESIDENT_PERMS = [
  PERMISSIONS.HOUSEHOLD_VIEW,
  PERMISSIONS.HOUSEHOLD_CREATE,
  PERMISSIONS.HOUSEHOLD_UPDATE,
  PERMISSIONS.HOUSEHOLD_DELETE,
];
const STAFF_PERMS = [...RESIDENT_PERMS, PERMISSIONS.RESIDENT_APPROVE, PERMISSIONS.RESIDENT_UPDATE];

async function makeResident(email: string, estateId = ESTATE_A) {
  const user = await UserModel.create({
    firstName: 'Head',
    lastName: 'OfHouse',
    email,
    phone: `+23480${Math.floor(Math.random() * 100000000)}`,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(`${Math.random()}`, 'phone'),
    passwordHash: 'x',
    status: 'active',
  });

  const membership = await MembershipModel.create({
    estateId: new mongoose.Types.ObjectId(estateId),
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });

  return { userId: user._id.toHexString(), membershipId: membership._id.toHexString() };
}

beforeEach(async () => {
  await UserModel.syncIndexes();
  await DependantModel.syncIndexes();

  const guardian = await makeResident('guardian@example.com');
  guardianUserId = guardian.userId;
  guardianMembershipId = guardian.membershipId;

  neighbourMembershipId = (await makeResident('neighbour@example.com')).membershipId;
});

const guardian = () => ctx(guardianUserId, RESIDENT_PERMS);
const staff = () => ctx(new mongoose.Types.ObjectId().toHexString(), STAFF_PERMS);

const child = {
  firstName: 'Chidi',
  lastName: 'Okonkwo',
  relationship: 'child' as const,
  dateOfBirth: new Date('2018-04-12'),
};

describe('adding dependants', () => {
  it('adds a dependant without creating an account', async () => {
    const dependant = await householdService.addDependant(guardian(), {
      guardianMembershipId,
      ...child,
    });

    expect(dependant.firstName).toBe('Chidi');
    expect(dependant.isActive).toBe(true);

    // A five-year-old has no email, phone or password. Manufacturing a stub
    // account would put a permanently unverifiable row in the identity
    // collection.
    expect(await UserModel.countDocuments()).toBe(2);
  });

  it('inherits the guardian property', async () => {
    const propertyId = new mongoose.Types.ObjectId();
    await MembershipModel.updateOne({ _id: guardianMembershipId }, { $set: { propertyId } });

    const dependant = await householdService.addDependant(guardian(), {
      guardianMembershipId,
      ...child,
    });

    expect(dependant.propertyId?.toHexString()).toBe(propertyId.toHexString());
  });

  it('rejects a future date of birth', async () => {
    await expect(
      householdService.addDependant(guardian(), {
        guardianMembershipId,
        ...child,
        dateOfBirth: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('encrypts a dependant NIN and stores the last four digits', async () => {
    const dependant = await householdService.addDependant(guardian(), {
      guardianMembershipId,
      firstName: 'Ngozi',
      lastName: 'Bello',
      relationship: 'domestic-staff',
      nin: '12345678911',
    });

    expect(dependant.ninLast4).toBe('8911');
    expect(JSON.stringify(dependant)).not.toContain('12345678911');
    expect(dependant.ninIndex).toBe(blindIndex('12345678911', 'nin'));
  });

  // A NIN identifies one person platform-wide, whether or not they hold an
  // account.
  describe('duplicate identity', () => {
    it('rejects a NIN already held by an account', async () => {
      await UserModel.updateOne(
        { _id: guardianUserId },
        { $set: { ninIndex: blindIndex('12345678911', 'nin') } },
      );

      await expect(
        householdService.addDependant(guardian(), {
          guardianMembershipId,
          firstName: 'X',
          lastName: 'Y',
          relationship: 'ward',
          nin: '12345678911',
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
    });

    it('rejects a NIN already held by another dependant', async () => {
      const input = {
        guardianMembershipId,
        firstName: 'A',
        lastName: 'B',
        relationship: 'ward' as const,
        nin: '12345678911',
      };

      await householdService.addDependant(guardian(), input);
      await expect(
        householdService.addDependant(guardian(), { ...input, firstName: 'C' }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
    });
  });

  it('never writes the NIN to the audit trail', async () => {
    await householdService.addDependant(guardian(), {
      guardianMembershipId,
      firstName: 'A',
      lastName: 'B',
      relationship: 'ward',
      nin: '12345678911',
    });

    const entries = await AuditLogModel.find({ resource: 'dependant' }).lean();
    expect(JSON.stringify(entries)).not.toContain('12345678911');
    // Named to avoid the redaction filter, which matches field names loosely
    // and would blank a boolean called `hasNin`.
    expect(entries[0]?.metadata).toMatchObject({ identityProvided: true });
  });
});

describe('household boundaries', () => {
  // household.create alone would otherwise let any resident add a dependant to
  // a neighbour's house — and a dependant is someone the gate will admit.
  it('refuses a resident adding a dependant to another household', async () => {
    await expect(
      householdService.addDependant(guardian(), {
        guardianMembershipId: neighbourMembershipId,
        ...child,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows staff to manage any household', async () => {
    await expect(
      householdService.addDependant(staff(), {
        guardianMembershipId: neighbourMembershipId,
        ...child,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a resident listing another household', async () => {
    await expect(
      householdService.listForGuardian(guardian(), neighbourMembershipId),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lists only the guardian own dependants', async () => {
    await householdService.addDependant(guardian(), { guardianMembershipId, ...child });
    await householdService.addDependant(staff(), {
      guardianMembershipId: neighbourMembershipId,
      firstName: 'Other',
      lastName: 'Child',
      relationship: 'child',
    });

    const mine = await householdService.listForGuardian(guardian(), guardianMembershipId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.firstName).toBe('Chidi');
  });

  it('requires the household permission', async () => {
    await expect(
      householdService.addDependant(ctx(guardianUserId, []), {
        guardianMembershipId,
        ...child,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('removing a dependant', () => {
  // Gate logs record who entered and left, and must stay resolvable long after
  // a child has grown up or a driver has changed employer.
  it('marks as departed rather than deleting', async () => {
    const dependant = await householdService.addDependant(guardian(), {
      guardianMembershipId,
      ...child,
    });

    await householdService.removeDependant(guardian(), dependant._id.toHexString(), 'Moved abroad');

    const retained = await DependantModel.findById(dependant._id).lean();
    expect(retained).not.toBeNull();
    expect(retained?.isActive).toBe(false);
    expect(retained?.departedAt).toBeInstanceOf(Date);

    expect(await householdService.listForGuardian(guardian(), guardianMembershipId)).toHaveLength(
      0,
    );
  });
});

describe('tenant isolation', () => {
  it('hides dependants from another estate', async () => {
    const dependant = await householdService.addDependant(guardian(), {
      guardianMembershipId,
      ...child,
    });

    const foreign = ctx(new mongoose.Types.ObjectId().toHexString(), STAFF_PERMS, ESTATE_B);

    await expect(
      householdService.updateDependant(foreign, dependant._id.toHexString(), {
        firstName: 'Hijack',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
