/**
 * The resident directory.
 *
 * The property under test is what each view is allowed to contain. NIN exposure
 * is the main risk: it must never appear in a list, must be masked in a detail
 * view, and must be audited every time the full value is revealed.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex, encryptField } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { residentService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();
const NIN = '12345678911';

function ctx(permissions: string[], estateId = ESTATE_A): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-manager'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const viewer = () => ctx([PERMISSIONS.RESIDENT_VIEW]);
const approver = () => ctx([PERMISSIONS.RESIDENT_VIEW, PERMISSIONS.RESIDENT_APPROVE]);
const ninViewer = () => ctx([PERMISSIONS.RESIDENT_VIEW, PERMISSIONS.RESIDENT_VIEW_NIN]);

async function makeResident(
  overrides: {
    firstName?: string;
    lastName?: string;
    estateId?: string;
    withNin?: boolean;
    status?: string;
  } = {},
) {
  const email = `r${Math.random().toString(36).slice(2)}@example.com`;
  const phone = `+23480${Math.floor(Math.random() * 100000000)}`;
  const estateId = overrides.estateId ?? ESTATE_A;

  const user = await UserModel.create({
    firstName: overrides.firstName ?? 'Ada',
    lastName: overrides.lastName ?? 'Okonkwo',
    email,
    phone,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(phone, 'phone'),
    passwordHash: 'x',
    status: 'active',
    ...(overrides.withNin
      ? {
          nin: encryptField(NIN, `user:placeholder:nin`),
          ninIndex: blindIndex(NIN, 'nin'),
          ninLast4: '8911',
          ninVerifiedAt: new Date(),
        }
      : {}),
  });

  // Context binding uses the real user id, so it must be written afterwards.
  if (overrides.withNin) {
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { nin: encryptField(NIN, `user:${user._id.toHexString()}:nin`) } },
    );
  }

  const membership = await MembershipModel.create({
    estateId: new mongoose.Types.ObjectId(estateId),
    userId: user._id,
    category: 'homeowner',
    status: overrides.status ?? 'active',
    roleIds: [],
  });

  return { userId: user._id.toHexString(), membershipId: membership._id.toHexString() };
}

beforeEach(async () => {
  await UserModel.syncIndexes();
  await MembershipModel.syncIndexes();
});

describe('directory listing', () => {
  it('lists residents of the calling estate only', async () => {
    await makeResident({ firstName: 'Ada' });
    await makeResident({ firstName: 'Bayo', estateId: ESTATE_B });

    const page = await residentService.list(viewer());
    expect(page.total).toBe(1);
    expect(page.items[0]?.fullName).toBe('Ada Okonkwo');
  });

  // The directory is the widest-read surface in the system.
  it('never includes a NIN, even masked', async () => {
    await makeResident({ withNin: true });

    const page = await residentService.list(viewer());
    const serialised = JSON.stringify(page.items);

    expect(serialised).not.toContain(NIN);
    expect(serialised).not.toContain('8911');
    expect(page.items[0]).not.toHaveProperty('ninMasked');
  });

  it('omits contact details from the list', async () => {
    await makeResident();
    const item = (await residentService.list(viewer())).items[0]!;

    expect(item).not.toHaveProperty('email');
    expect(item).not.toHaveProperty('phone');
  });

  it('filters by status and category', async () => {
    await makeResident({ status: 'active' });
    await makeResident({ status: 'pending' });

    expect((await residentService.list(viewer(), { status: 'pending' })).total).toBe(1);
    expect((await residentService.list(viewer(), { category: 'tenant' })).total).toBe(0);
  });

  it('searches by name', async () => {
    await makeResident({ firstName: 'Chidi', lastName: 'Eze' });
    await makeResident({ firstName: 'Ngozi', lastName: 'Bello' });

    const page = await residentService.list(viewer(), { search: 'Chidi' });
    expect(page.total).toBe(1);
    expect(page.items[0]?.fullName).toBe('Chidi Eze');
  });

  // A user-supplied search string must not become a pattern.
  it('treats regex metacharacters as literal text', async () => {
    await makeResident({ firstName: 'Ada' });
    const page = await residentService.list(viewer(), { search: '.*' });
    expect(page.total).toBe(0);
  });

  it('requires resident.view', async () => {
    await expect(residentService.list(ctx([]))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('resident detail', () => {
  it('includes contact details but masks the NIN', async () => {
    const { membershipId } = await makeResident({ withNin: true });
    const detail = await residentService.detail(viewer(), membershipId);

    expect(detail.email).toContain('@');
    expect(detail.ninMasked).toBe('•••••••8911');
    expect(JSON.stringify(detail)).not.toContain(NIN);
  });

  it('reports no NIN when none is on record', async () => {
    const { membershipId } = await makeResident({ withNin: false });
    expect((await residentService.detail(viewer(), membershipId)).ninMasked).toBeNull();
  });

  it('reports another estate resident as not found', async () => {
    const { membershipId } = await makeResident({ estateId: ESTATE_B });
    await expect(residentService.detail(viewer(), membershipId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('revealing a NIN', () => {
  it('requires the dedicated permission', async () => {
    const { membershipId } = await makeResident({ withNin: true });

    // A manager who can approve residents still cannot read their NIN.
    await expect(residentService.revealNin(approver(), membershipId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('returns the full value to a holder of the permission', async () => {
    const { membershipId } = await makeResident({ withNin: true });
    expect(await residentService.revealNin(ninViewer(), membershipId)).toEqual({ nin: NIN });
  });

  // A permission used routinely and never recorded is indistinguishable from no
  // permission at all.
  it('audits every successful read, without recording the value', async () => {
    const { membershipId } = await makeResident({ withNin: true });
    await residentService.revealNin(ninViewer(), membershipId);

    const entry = await AuditLogModel.findOne({ action: 'resident.nin_revealed' }).lean();
    expect(entry?.outcome).toBe('success');
    expect(JSON.stringify(entry)).not.toContain(NIN);
  });

  it('audits a failed read', async () => {
    const { membershipId } = await makeResident({ withNin: false });

    await expect(residentService.revealNin(ninViewer(), membershipId)).rejects.toMatchObject({
      statusCode: 404,
    });

    const entry = await AuditLogModel.findOne({ action: 'resident.nin_revealed' }).lean();
    expect(entry?.outcome).toBe('failure');
  });

  it('cannot reach another estate resident', async () => {
    const { membershipId } = await makeResident({ withNin: true, estateId: ESTATE_B });
    await expect(residentService.revealNin(ninViewer(), membershipId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('gate identity', () => {
  // The gate terminal is shared between shifts and often unattended. An officer
  // needs to know this person belongs here and which house they are for.
  it('exposes only what a gate screen needs', async () => {
    const { membershipId } = await makeResident({ withNin: true });
    const identity = await residentService.gateIdentity(viewer(), membershipId);

    expect(Object.keys(identity).sort()).toEqual([
      'category',
      'fullName',
      'membershipId',
      'photoUrl',
      'residentCode',
      'status',
      'unitNumber',
    ]);

    const serialised = JSON.stringify(identity);
    expect(serialised).not.toContain(NIN);
    expect(serialised).not.toContain('8911');
    expect(serialised).not.toContain('@');
  });
});

describe('approval', () => {
  it('activates a pending membership and issues a resident code', async () => {
    const { membershipId } = await makeResident({ status: 'pending' });
    const approved = await residentService.approve(approver(), membershipId);

    expect(approved.status).toBe('active');
    expect(approved.residentCode).toMatch(/^R-\d{4}-\d{5}$/);
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it('is idempotent for an already active membership', async () => {
    const { membershipId } = await makeResident({ status: 'active' });
    const first = await residentService.approve(approver(), membershipId);
    const second = await residentService.approve(approver(), membershipId);

    expect(second.residentCode).toBe(first.residentCode);
  });

  it('requires resident.approve', async () => {
    const { membershipId } = await makeResident({ status: 'pending' });
    await expect(residentService.approve(viewer(), membershipId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('records approval and rejection in the trail', async () => {
    const a = await makeResident({ status: 'pending' });
    const b = await makeResident({ status: 'pending' });

    await residentService.approve(approver(), a.membershipId);
    await residentService.reject(approver(), b.membershipId, 'Documents not provided');

    const actions = await AuditLogModel.find({ resource: 'resident' }).lean();
    expect(actions.map((entry) => entry.action).sort()).toEqual([
      'resident.approved',
      'resident.rejected',
    ]);
  });
});
