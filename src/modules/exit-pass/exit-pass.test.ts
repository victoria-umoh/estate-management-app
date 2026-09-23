/**
 * Exit (removal) passes.
 *
 * The workflow this covers is the one the feature exists for: a resident
 * declares a manifest, an approver authorises it, the gate checks the load and
 * closes the pass — and the pass never works again.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { events } from '@/core/events';
import { PERMISSIONS } from '@/core/rbac';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { EstateModel } from '@/modules/estate';
import { gateService } from '@/modules/gate';
import { GateModel } from '@/modules/gate/schema';
import { MembershipModel } from '@/modules/membership/schema';
import { MovementModel } from '@/modules/movement';
import { UserModel } from '@/modules/user/schema';
import { ExitPassModel } from './schema';
import { exitPassRepository, exitPassService } from './service';

setupTestDatabase();

let estateId: string;
let residentUserId: string;
let residentMembershipId: string;
let gateId: string;

function ctx(userId: string, permissions: string[], estate = estateId): RequestContext {
  return {
    userId,
    estateId: estate,
    roles: ['resident'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const RESIDENT = [PERMISSIONS.EXIT_PASS_VIEW, PERMISSIONS.EXIT_PASS_CREATE];
const OFFICER = [
  PERMISSIONS.EXIT_PASS_VIEW,
  PERMISSIONS.EXIT_PASS_VERIFY,
  PERMISSIONS.EXIT_PASS_CLOSE,
  PERMISSIONS.GATE_OPERATE,
  PERMISSIONS.GATE_LOG_VIEW,
];
// An estate manager holds the resident self-service permissions too, so the
// approver in these tests carries `exitPass.create` — which is exactly why the
// manifest lock has to be tested against them and not only against the
// resident.
const APPROVER = [...OFFICER, PERMISSIONS.EXIT_PASS_APPROVE, PERMISSIONS.EXIT_PASS_CREATE];

const resident = () => ctx(residentUserId, RESIDENT);
const officer = () => ctx(new mongoose.Types.ObjectId().toHexString(), OFFICER);
const approver = () => ctx(new mongoose.Types.ObjectId().toHexString(), APPROVER);
const admin = () => ctx(new mongoose.Types.ObjectId().toHexString(), ['*']);

async function makeEstate(overrides: Record<string, unknown> = {}) {
  return EstateModel.create({
    name: 'Palm Grove',
    slug: `palm-${Math.random().toString(36).slice(2)}`,
    address: { line1: '1 Palm Ave', city: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    contact: { email: 'a@b.com', phone: '+2348000000000' },
    status: 'active',
    settings: { requireExitPassApproval: true, ...overrides },
  });
}

async function makeMembership(estate: mongoose.Types.ObjectId) {
  const email = `r${Math.random().toString(36).slice(2)}@example.com`;
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

  const membership = await MembershipModel.create({
    estateId: estate,
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });

  return { user, membership };
}

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());
  await ExitPassModel.syncIndexes();
  await GateModel.syncIndexes();

  const estate = await makeEstate();
  estateId = estate._id.toHexString();

  const { user, membership } = await makeMembership(estate._id);
  residentUserId = user._id.toHexString();
  residentMembershipId = membership._id.toHexString();

  const gate = await gateService.create(admin(), { name: 'Main Gate', code: 'MAIN' });
  gateId = gate._id.toHexString();
});

afterEach(() => {
  setCache(undefined);
  events.removeAllHandlers();
});

function passInput(overrides: Record<string, unknown> = {}) {
  return {
    requestedByMembershipId: residentMembershipId,
    carrierName: 'Emeka Movers',
    carrierPhone: '+2348055555555',
    destination: '12 Awolowo Road, Ikoyi',
    reason: 'Moving a sofa to a new flat',
    items: [
      { quantity: 1, description: 'Three-seater sofa', identifyingMark: 'Brown leather' },
      { quantity: 2, description: 'Cardboard boxes' },
    ],
    ...overrides,
  };
}

async function approvedPass() {
  const { pass } = await exitPassService.create(resident(), passInput());
  const approved = await exitPassService.approve(approver(), pass._id.toHexString());
  return approved;
}

describe('declaring a removal', () => {
  it('records the manifest and waits for approval', async () => {
    const { pass, token } = await exitPassService.create(resident(), passInput());

    expect(pass.status).toBe('pending');
    expect(pass.approvalRequired).toBe(true);
    expect(pass.items).toHaveLength(2);
    expect(pass.items[0]?.description).toBe('Three-seater sofa');
    // No credential until someone authorises the removal.
    expect(token).toBeNull();
    expect(pass.credentialId ?? null).toBeNull();
  });

  it('uses a code an officer can read aloud without ambiguity', async () => {
    for (let index = 0; index < 20; index++) {
      const { pass } = await exitPassService.create(resident(), passInput());
      expect(pass.code).toHaveLength(6);
      expect(pass.code).not.toMatch(/[O0I1S5]/);
    }
  });

  // A manifest with nothing on it authorises anything.
  it('refuses an empty manifest', async () => {
    await expect(
      exitPassService.create(resident(), passInput({ items: [] })),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses an item with no description', async () => {
    await expect(
      exitPassService.create(resident(), passInput({ items: [{ quantity: 1, description: ' ' }] })),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses a resident declaring goods out of another household', async () => {
    const { membership } = await makeMembership(new mongoose.Types.ObjectId(estateId));

    await expect(
      exitPassService.create(
        resident(),
        passInput({ requestedByMembershipId: membership._id.toHexString() }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires exitPass.create', async () => {
    await expect(
      exitPassService.create(ctx(residentUserId, [PERMISSIONS.EXIT_PASS_VIEW]), passInput()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the declaration in the audit trail', async () => {
    await exitPassService.create(resident(), passInput());
    expect(await AuditLogModel.countDocuments({ action: 'exit_pass.created' })).toBe(1);
  });
});

describe('the approval gate', () => {
  it('issues the credential only once an approver acts', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());

    const verifyBefore = await exitPassService.verifyAtGate(officer(), pass.code);
    expect(verifyBefore.usable).toBe(false);
    expect(verifyBefore.message).toMatch(/not been approved/);

    const { pass: approved, token } = await exitPassService.approve(
      approver(),
      pass._id.toHexString(),
    );

    expect(approved.status).toBe('approved');
    expect(token).toMatch(/^v1\./);

    const verifyAfter = await exitPassService.verifyAtGate(officer(), pass.code);
    expect(verifyAfter.usable).toBe(true);
  });

  // Configurable per estate: an estate that trusts its residents skips the step
  // but still gets the manifest and the gate record.
  it('skips approval when the estate does not require it', async () => {
    const estate = await makeEstate({ requireExitPassApproval: false });
    const { user, membership } = await makeMembership(estate._id);

    const context = ctx(user._id.toHexString(), RESIDENT, estate._id.toHexString());
    const { pass, token } = await exitPassService.create(context, {
      ...passInput(),
      requestedByMembershipId: membership._id.toHexString(),
    });

    expect(pass.approvalRequired).toBe(false);
    expect(pass.status).toBe('approved');
    expect(token).toMatch(/^v1\./);
  });

  it('requires exitPass.approve', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());

    await expect(
      exitPassService.approve(officer(), pass._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lets an approver refuse, with a reason on the record', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());
    const rejected = await exitPassService.reject(
      approver(),
      pass._id.toHexString(),
      'Items not owned by this household',
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.decisionReason).toBe('Items not owned by this household');

    const verify = await exitPassService.verifyAtGate(officer(), pass.code);
    expect(verify.usable).toBe(false);
  });

  it('refuses to approve a pass twice', async () => {
    const approved = await approvedPass();

    await expect(
      exitPassService.approve(approver(), approved.pass._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the manifest as evidence', () => {
  it('can be amended while the pass is still pending', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());

    const amended = await exitPassService.updateManifest(resident(), pass._id.toHexString(), [
      { quantity: 1, description: 'Three-seater sofa' },
      { quantity: 3, description: 'Cardboard boxes' },
    ]);

    expect(amended.items[1]?.quantity).toBe(3);
  });

  // The whole reason the record exists: a list the person being checked can
  // still edit is not a list anyone can check a load against.
  it('is immutable once approved', async () => {
    const { pass } = await approvedPass();

    await expect(
      exitPassService.updateManifest(resident(), pass._id.toHexString(), [
        { quantity: 40, description: 'Cardboard boxes' },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });

    const unchanged = await ExitPassModel.findById(pass._id).lean();
    expect(unchanged?.items).toHaveLength(2);
    expect(unchanged?.manifestLockedAt).toBeInstanceOf(Date);
  });

  it('is immutable for an approver too, not only for the resident', async () => {
    const { pass } = await approvedPass();

    await expect(
      exitPassService.updateManifest(approver(), pass._id.toHexString(), [
        { quantity: 1, description: 'A different sofa' },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the gate', () => {
  it('shows the officer what was declared', async () => {
    const { pass } = await approvedPass();

    const result = await exitPassService.verifyAtGate(officer(), pass.code.toLowerCase());

    expect(result.usable).toBe(true);
    expect(result.pass?.items.map((item) => item.description)).toEqual([
      'Three-seater sofa',
      'Cardboard boxes',
    ]);
  });

  it('returns the manifest even when the pass is refused', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());
    const result = await exitPassService.verifyAtGate(officer(), pass.code);

    expect(result.usable).toBe(false);
    expect(result.pass?.items).toHaveLength(2);
  });

  it('records the removal in the gate log, with the manifest copied in', async () => {
    const { pass } = await approvedPass();
    await exitPassService.close(officer(), pass._id.toHexString(), { gateId });

    const movement = await MovementModel.findOne({ subjectId: pass._id }).lean();
    expect(movement?.direction).toBe('out');
    expect(movement?.subject).toBe('exit-pass');
    expect(movement?.admitted).toBe(true);
    expect(movement?.notes).toMatch(/1 × Three-seater sofa/);
  });

  // The point of the whole feature: one authorisation, one load.
  it('cannot be used a second time', async () => {
    const { pass } = await approvedPass();

    const closed = await exitPassService.close(officer(), pass._id.toHexString(), { gateId });
    expect(closed.status).toBe('used');

    await expect(
      exitPassService.close(officer(), pass._id.toHexString(), { gateId }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const verify = await exitPassService.verifyAtGate(officer(), pass.code);
    expect(verify.usable).toBe(false);
    expect(verify.message).toMatch(/already been used/);
  });

  it('revokes the credential when the pass closes', async () => {
    const { pass, token } = await approvedPass();
    await exitPassService.close(officer(), pass._id.toHexString(), { gateId });

    const scan = await gateService.processScan(
      ctx(new mongoose.Types.ObjectId().toHexString(), [...OFFICER, PERMISSIONS.GATE_OPERATE]),
      { token, gateId, direction: 'out' },
    );

    expect(scan.admitted).toBe(false);
    expect(scan.reason).toBe('revoked');
  });

  it('refuses to close a pass that was never approved', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());

    await expect(
      exitPassService.close(officer(), pass._id.toHexString(), { gateId }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to close an expired pass', async () => {
    const { pass } = await approvedPass();
    await ExitPassModel.updateOne(
      { _id: pass._id },
      { $set: { validUntil: new Date(Date.now() - 60_000) } },
    );

    await expect(
      exitPassService.close(officer(), pass._id.toHexString(), { gateId }),
    ).rejects.toThrow(/expired/);
  });

  it('requires exitPass.close', async () => {
    const { pass } = await approvedPass();

    await expect(
      exitPassService.close(resident(), pass._id.toHexString(), { gateId }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('withdrawing', () => {
  it('lets the household cancel its own pending pass', async () => {
    const { pass } = await exitPassService.create(resident(), passInput());
    const cancelled = await exitPassService.revoke(resident(), pass._id.toHexString(), 'Not today');

    expect(cancelled.status).toBe('cancelled');
  });

  it('refuses to rewrite a removal that already happened', async () => {
    const { pass } = await approvedPass();
    await exitPassService.close(officer(), pass._id.toHexString(), { gateId });

    await expect(
      exitPassService.revoke(approver(), pass._id.toHexString(), 'Changed my mind'),
    ).rejects.toThrow(/already been used/);
  });
});

describe('tenant isolation', () => {
  it('does not find a pass from another estate', async () => {
    const { pass } = await approvedPass();

    const otherEstate = await makeEstate();
    const otherContext = ctx(
      new mongoose.Types.ObjectId().toHexString(),
      APPROVER,
      otherEstate._id.toHexString(),
    );

    // 404, never 403: confirming the id exists elsewhere is itself a leak.
    await expect(
      exitPassRepository.findByIdOrFail(otherContext, pass._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      exitPassService.close(otherContext, pass._id.toHexString(), { gateId }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const verify = await exitPassService.verifyAtGate(otherContext, pass.code);
    expect(verify.usable).toBe(false);
    expect(verify.pass).toBeNull();
  });

  it('lists only the caller own passes for someone who cannot approve', async () => {
    await exitPassService.create(resident(), passInput());

    const { user, membership } = await makeMembership(new mongoose.Types.ObjectId(estateId));
    const neighbour = ctx(user._id.toHexString(), RESIDENT);
    await exitPassService.create(neighbour, {
      ...passInput(),
      requestedByMembershipId: membership._id.toHexString(),
    });

    const theirs = await exitPassService.list(neighbour, {}, membership._id.toHexString());
    expect(theirs.total).toBe(1);

    // Asking for someone else's is simply ignored, not honoured.
    const probing = await exitPassService.list(
      neighbour,
      { requestedByMembershipId: residentMembershipId },
      membership._id.toHexString(),
    );
    expect(probing.total).toBe(1);
    expect(probing.items[0]?.requestedByMembershipId.toHexString()).toBe(
      membership._id.toHexString(),
    );

    const staff = await exitPassService.list(approver(), {}, residentMembershipId);
    expect(staff.total).toBe(2);
  });
});
