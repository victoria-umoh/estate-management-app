/**
 * The approval workflow for load-bearing resident details.
 *
 * The control being tested is separation of duties: proposing a change and
 * making it are different acts performed by different people.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { changeRequestService } from './service';
import { ChangeRequestModel } from './schema';

setupTestDatabase();

const ESTATE = new mongoose.Types.ObjectId().toHexString();

let residentUserId: string;
let membershipId: string;

function ctx(userId: string, permissions: string[]): RequestContext {
  return {
    userId,
    estateId: ESTATE,
    roles: ['resident'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const RESIDENT_PERMS = [PERMISSIONS.RESIDENT_VIEW];
const REVIEWER_PERMS = [PERMISSIONS.RESIDENT_APPROVE, PERMISSIONS.RESIDENT_UPDATE];

beforeEach(async () => {
  await UserModel.syncIndexes();
  await ChangeRequestModel.syncIndexes();

  const user = await UserModel.create({
    firstName: 'Ada',
    lastName: 'Okonkwo',
    email: 'ada@example.com',
    phone: '+2348012345678',
    emailIndex: blindIndex('ada@example.com', 'email'),
    phoneIndex: blindIndex('+2348012345678', 'phone'),
    passwordHash: 'x',
    status: 'active',
  });
  residentUserId = user._id.toHexString();

  const membership = await MembershipModel.create({
    estateId: new mongoose.Types.ObjectId(ESTATE),
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });
  membershipId = membership._id.toHexString();
});

const resident = () => ctx(residentUserId, RESIDENT_PERMS);
const reviewer = () => ctx(new mongoose.Types.ObjectId().toHexString(), REVIEWER_PERMS);

describe('submitting a request', () => {
  it('lets a resident propose a change to their own details', async () => {
    const request = await changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
      reason: 'Changed network',
    });

    expect(request.status).toBe('pending');
    expect(request.field).toBe('phone');
  });

  it('refuses a resident proposing a change to someone else', async () => {
    const stranger = ctx(new mongoose.Types.ObjectId().toHexString(), RESIDENT_PERMS);

    await expect(
      changeRequestService.submit(stranger, {
        membershipId,
        field: 'phone',
        value: '+2348099999999',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows staff to propose on behalf of a resident', async () => {
    await expect(
      changeRequestService.submit(reviewer(), {
        membershipId,
        field: 'phone',
        value: '+2348099999999',
      }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  // A pending request must not become a plaintext copy of the value it exists
  // to protect.
  it('encrypts a proposed NIN and never stores it in the clear', async () => {
    await changeRequestService.submit(resident(), {
      membershipId,
      field: 'nin',
      value: '12345678911',
    });

    const stored = await ChangeRequestModel.findOne().lean();
    expect(stored?.requestedValue).toBeNull();
    expect(stored?.requestedValueEncrypted).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('12345678911');
    // The reviewer still sees enough to judge it.
    expect(stored?.requestedValueLabel).toBe('•••••••8911');
  });

  it('masks non-sensitive values in the reviewer label', async () => {
    await changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
    });

    const stored = await ChangeRequestModel.findOne().lean();
    expect(stored?.requestedValueLabel).not.toContain('9999999');
    expect(stored?.currentValueLabel).not.toContain('8012345');
  });

  // Two open requests for one field would let a reviewer approve one while the
  // other stays live and later overwrites it without a second review.
  it('permits only one pending request per field', async () => {
    const input = { membershipId, field: 'phone' as const, value: '+2348099999999' };

    await changeRequestService.submit(resident(), input);
    await expect(changeRequestService.submit(resident(), input)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('allows pending requests for different fields at once', async () => {
    await changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
    });
    await expect(
      changeRequestService.submit(resident(), {
        membershipId,
        field: 'nin',
        value: '12345678911',
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a value already held by another account', async () => {
    await UserModel.create({
      firstName: 'Other',
      lastName: 'Person',
      email: 'other@example.com',
      phone: '+2348077777777',
      emailIndex: blindIndex('other@example.com', 'email'),
      phoneIndex: blindIndex('+2348077777777', 'phone'),
      passwordHash: 'x',
      status: 'active',
    });

    await expect(
      changeRequestService.submit(resident(), {
        membershipId,
        field: 'phone',
        value: '+2348077777777',
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });
  });
});

describe('reviewing a request', () => {
  async function pendingPhoneChange() {
    return changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
    });
  }

  it('applies the change on approval', async () => {
    const request = await pendingPhoneChange();
    await changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true });

    const user = await UserModel.findById(residentUserId).lean();
    expect(user?.phone).toBe('+2348099999999');
    expect(user?.phoneIndex).toBe(blindIndex('+2348099999999', 'phone'));
  });

  // Carrying the old verification across to a new number would be a lie, and
  // the new number is a password-reset path.
  it('clears verification when the underlying value changes', async () => {
    await UserModel.updateOne({ _id: residentUserId }, { $set: { phoneVerifiedAt: new Date() } });

    const request = await pendingPhoneChange();
    await changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true });

    expect((await UserModel.findById(residentUserId).lean())?.phoneVerifiedAt).toBeNull();
  });

  it('leaves the record untouched on rejection', async () => {
    const request = await pendingPhoneChange();
    await changeRequestService.review(reviewer(), request._id.toHexString(), {
      approve: false,
      note: 'No supporting document',
    });

    const user = await UserModel.findById(residentUserId).lean();
    expect(user?.phone).toBe('+2348012345678');

    const stored = await ChangeRequestModel.findById(request._id).lean();
    expect(stored?.status).toBe('rejected');
    expect(stored?.reviewNote).toBe('No supporting document');
  });

  // The control this whole workflow exists for.
  it('refuses to let the submitter review their own request', async () => {
    const staff = ctx(new mongoose.Types.ObjectId().toHexString(), REVIEWER_PERMS);
    const request = await changeRequestService.submit(staff, {
      membershipId,
      field: 'nin',
      value: '12345678911',
    });

    await expect(
      changeRequestService.review(staff, request._id.toHexString(), { approve: true }),
    ).rejects.toThrow(/cannot review a change request you submitted/i);
  });

  it('requires resident.approve to review', async () => {
    const request = await pendingPhoneChange();

    await expect(
      changeRequestService.review(
        ctx(new mongoose.Types.ObjectId().toHexString(), RESIDENT_PERMS),
        request._id.toHexString(),
        {
          approve: true,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses to review a request twice', async () => {
    const request = await pendingPhoneChange();
    await changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true });

    await expect(
      changeRequestService.review(reviewer(), request._id.toHexString(), { approve: false }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('decrypts and applies an approved NIN change', async () => {
    const request = await changeRequestService.submit(resident(), {
      membershipId,
      field: 'nin',
      value: '12345678911',
    });

    await changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true });

    const user = await UserModel.findById(residentUserId).lean();
    expect(user?.ninIndex).toBe(blindIndex('12345678911', 'nin'));
    expect(user?.ninLast4).toBe('8911');
    // Requires fresh verification — the new number has not been checked.
    expect(user?.ninVerifiedAt).toBeNull();
    expect(JSON.stringify(user)).not.toContain('12345678911');
  });

  // The value may have been taken by another account while the request sat in
  // the queue.
  it('re-checks availability at approval, not only at submission', async () => {
    const request = await pendingPhoneChange();

    await UserModel.create({
      firstName: 'Race',
      lastName: 'Winner',
      email: 'race@example.com',
      phone: '+2348099999999',
      emailIndex: blindIndex('race@example.com', 'email'),
      phoneIndex: blindIndex('+2348099999999', 'phone'),
      passwordHash: 'x',
      status: 'active',
    });

    await expect(
      changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_IDENTITY' });

    // The request stays pending rather than being marked approved.
    expect((await ChangeRequestModel.findById(request._id).lean())?.status).toBe('pending');
  });
});

describe('withdrawing', () => {
  it('lets the submitter withdraw', async () => {
    const request = await changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
    });

    await changeRequestService.withdraw(resident(), request._id.toHexString());
    expect((await ChangeRequestModel.findById(request._id).lean())?.status).toBe('withdrawn');
  });

  it('refuses withdrawal by anyone else', async () => {
    const request = await changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
    });

    await expect(
      changeRequestService.withdraw(reviewer(), request._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('audit trail', () => {
  it('records submission and decision', async () => {
    const request = await changeRequestService.submit(resident(), {
      membershipId,
      field: 'phone',
      value: '+2348099999999',
    });
    await changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true });

    const actions = await AuditLogModel.find({ resource: 'change_request' })
      .sort({ createdAt: 1 })
      .lean();

    expect(actions.map((entry) => entry.action)).toEqual([
      'change_request.submitted',
      'change_request.approved',
    ]);
  });

  it('never writes the proposed value to the trail', async () => {
    const request = await changeRequestService.submit(resident(), {
      membershipId,
      field: 'nin',
      value: '12345678911',
    });
    await changeRequestService.review(reviewer(), request._id.toHexString(), { approve: true });

    const entries = await AuditLogModel.find({ resource: 'change_request' }).lean();
    expect(JSON.stringify(entries)).not.toContain('12345678911');
  });
});
