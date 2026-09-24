/**
 * The resident directory.
 *
 * The property under test is what each view is allowed to contain. NIN exposure
 * is the main risk: it must never appear in a list, must be masked in a detail
 * view, and must be audited every time the full value is revealed.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex, encryptField } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import { AuditLogModel } from '@/modules/audit';
import { AccessCredentialModel, credentialService } from '@/modules/credential';
import { MembershipModel } from '@/modules/membership/schema';
import { PropertyModel, PropertyOccupancyModel } from '@/modules/property';
import { UserModel } from '@/modules/user/schema';
import { VehicleModel } from '@/modules/vehicle';
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

/** The directory permission every resident holds. */
const viewer = () => ctx([PERMISSIONS.RESIDENT_VIEW]);
/** Staff, who may read a full record including contact details. */
const staffViewer = () => ctx([PERMISSIONS.RESIDENT_VIEW, PERMISSIONS.RESIDENT_VIEW_ALL]);
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
    const detail = await residentService.detail(staffViewer(), membershipId);

    expect(detail.email).toContain('@');
    expect(detail.ninMasked).toBe('•••••••8911');
    expect(JSON.stringify(detail)).not.toContain(NIN);
  });

  it('reports no NIN when none is on record', async () => {
    const { membershipId } = await makeResident({ withNin: false });
    expect((await residentService.detail(staffViewer(), membershipId)).ninMasked).toBeNull();
  });

  /**
   * The directory permission is not enough to read a full record.
   *
   * `resident.view` is held by every resident so the directory works. It used
   * to gate this too, which meant any resident could read another household's
   * email, phone, date of birth, masked NIN and emergency contact — the third
   * time in this codebase that one permission was doing two jobs.
   */
  it('refuses a stranger\u2019s record to the directory permission alone', async () => {
    const { membershipId } = await makeResident({ withNin: true });

    // A 404, not a 403: confirming the membership exists is itself a
    // disclosure in a directory of this kind.
    await expect(residentService.detail(viewer(), membershipId)).rejects.toMatchObject({
      statusCode: 404,
    });
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

/**
 * Suspension and deletion.
 *
 * The property under test is that suspension actually takes access away. A
 * membership flipped to `suspended` while its credential stays live is a
 * suspended person who still opens the gate — which is the one thing
 * suspension exists to prevent.
 */
describe('suspending a resident', () => {
  const suspender = () => ctx([PERMISSIONS.RESIDENT_VIEW, PERMISSIONS.RESIDENT_SUSPEND]);

  beforeEach(() => setCache(new MemoryCacheAdapter()));
  afterEach(() => setCache(undefined));

  async function issueCredentialFor(context: RequestContext, membershipId: string) {
    return credentialService.issue(context, {
      subject: 'resident',
      subjectId: membershipId,
      display: {
        primaryLabel: 'Ada Okonkwo',
        secondaryLabel: null,
        unitNumber: '12B',
        category: 'homeowner',
        photoUrl: null,
      },
    });
  }

  it('keeps the record and marks it suspended', async () => {
    const { membershipId } = await makeResident();

    const updated = await residentService.suspend(suspender(), membershipId, 'Unpaid dues');

    expect(updated.status).toBe('suspended');
    expect(updated.rejectionReason).toBe('Unpaid dues');
    expect(await MembershipModel.countDocuments({ _id: updated._id })).toBe(1);
  });

  it('revokes the resident gate credential', async () => {
    const { membershipId } = await makeResident();
    const context = suspender();
    const { credential } = await issueCredentialFor(context, membershipId);

    await residentService.suspend(context, membershipId, 'Under investigation');

    const after = await AccessCredentialModel.findById(credential._id).lean();
    expect(after?.status).toBe('revoked');
  });

  it('revokes the credentials of vehicles registered to them', async () => {
    const { membershipId } = await makeResident();
    const context = suspender();

    const vehicle = await VehicleModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      plateNumber: 'ABC-123-XY',
      plateNormalised: 'ABC123XY',
      make: 'Toyota',
      model: 'Corolla',
      colour: 'Silver',
      type: 'car',
      ownerMembershipId: new mongoose.Types.ObjectId(membershipId),
      documentIds: [],
      status: 'active',
    });

    const { credential } = await credentialService.issue(context, {
      subject: 'vehicle',
      subjectId: vehicle._id.toHexString(),
      display: {
        primaryLabel: 'ABC-123-XY',
        secondaryLabel: 'Silver Toyota Corolla',
        unitNumber: null,
        category: 'homeowner',
        photoUrl: null,
      },
    });

    await residentService.suspend(context, membershipId, 'Unpaid dues');

    const after = await AccessCredentialModel.findById(credential._id).lean();
    expect(after?.status).toBe('revoked');
  });

  it('refuses to suspend someone twice', async () => {
    const { membershipId } = await makeResident();
    await residentService.suspend(suspender(), membershipId, 'Unpaid dues');

    await expect(
      residentService.suspend(suspender(), membershipId, 'Unpaid dues'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to suspend your own membership', async () => {
    const { userId, membershipId } = await makeResident();
    const self = { ...suspender(), userId };

    await expect(residentService.suspend(self, membershipId, 'Oops')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('requires resident.suspend', async () => {
    const { membershipId } = await makeResident();

    await expect(
      residentService.suspend(approver(), membershipId, 'Unpaid dues'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('treats a membership in another estate as not found', async () => {
    const { membershipId } = await makeResident({ estateId: ESTATE_B });

    await expect(
      residentService.suspend(suspender(), membershipId, 'Unpaid dues'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records the reason and the credential count in the audit trail', async () => {
    const { membershipId } = await makeResident();
    const context = suspender();
    await issueCredentialFor(context, membershipId);

    await residentService.suspend(context, membershipId, 'Unpaid dues');

    const entry = await AuditLogModel.findOne({ action: 'resident.suspended' }).lean();
    expect(entry?.reason).toBe('Unpaid dues');
    expect(entry?.metadata?.credentialsRevoked).toBe(1);
  });
});

describe('deleting a resident', () => {
  const remover = () => ctx([PERMISSIONS.RESIDENT_VIEW, PERMISSIONS.RESIDENT_DELETE]);

  beforeEach(() => setCache(new MemoryCacheAdapter()));
  afterEach(() => setCache(undefined));

  it('soft deletes, leaving the record for the audit trail', async () => {
    const { membershipId } = await makeResident();

    await residentService.remove(remover(), membershipId, 'Duplicate registration');

    const row = await MembershipModel.findById(membershipId).lean();
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('drops the resident out of the directory', async () => {
    const { membershipId } = await makeResident();
    await residentService.remove(remover(), membershipId, 'Duplicate registration');

    expect((await residentService.list(viewer())).total).toBe(0);
  });

  it('refuses while they still hold an occupancy, and says so', async () => {
    const { membershipId } = await makeResident();

    const property = await PropertyModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      unitNumber: '12B',
      street: 'Palm Avenue',
      type: 'duplex',
      currentOccupantCount: 1,
    });
    await PropertyOccupancyModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      propertyId: property._id,
      membershipId: new mongoose.Types.ObjectId(membershipId),
      role: 'tenant',
      startedAt: new Date(),
      recordedBy: new mongoose.Types.ObjectId(),
    });

    await expect(
      residentService.remove(remover(), membershipId, 'Duplicate registration'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('occupancy'),
    });
  });

  it('refuses while a vehicle is still registered to them, naming the plate', async () => {
    const { membershipId } = await makeResident();

    await VehicleModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      plateNumber: 'ABC-123-XY',
      plateNormalised: 'ABC123XY',
      make: 'Toyota',
      model: 'Corolla',
      colour: 'Silver',
      type: 'car',
      ownerMembershipId: new mongoose.Types.ObjectId(membershipId),
      documentIds: [],
      status: 'active',
    });

    await expect(
      residentService.remove(remover(), membershipId, 'Duplicate registration'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('ABC-123-XY'),
    });
  });

  it('revokes their credential on the way out', async () => {
    const { membershipId } = await makeResident();
    const context = remover();

    const { credential } = await credentialService.issue(context, {
      subject: 'resident',
      subjectId: membershipId,
      display: {
        primaryLabel: 'Ada Okonkwo',
        secondaryLabel: null,
        unitNumber: null,
        category: 'homeowner',
        photoUrl: null,
      },
    });

    await residentService.remove(context, membershipId, 'Duplicate registration');

    const after = await AccessCredentialModel.findById(credential._id).lean();
    expect(after?.status).toBe('revoked');
  });

  it('requires resident.delete', async () => {
    const { membershipId } = await makeResident();

    await expect(
      residentService.remove(approver(), membershipId, 'Duplicate registration'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the reason in the audit trail', async () => {
    const { membershipId } = await makeResident();
    await residentService.remove(remover(), membershipId, 'Duplicate registration');

    const entry = await AuditLogModel.findOne({ action: 'resident.deleted' }).lean();
    expect(entry?.reason).toBe('Duplicate registration');
  });
});
