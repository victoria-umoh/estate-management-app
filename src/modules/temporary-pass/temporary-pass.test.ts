/**
 * Temporary passes.
 *
 * The distinction under test is reusability: a contractor on a three-day job
 * goes in and out repeatedly on one pass, and the pass stops working when its
 * window closes rather than when it is first used.
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
import { TemporaryPassModel } from './schema';
import { temporaryPassRepository, temporaryPassService } from './service';

setupTestDatabase();

let estateId: string;
let sponsorMembershipId: string;
let gateId: string;

function ctx(userId: string, permissions: string[], estate = estateId): RequestContext {
  return {
    userId,
    estateId: estate,
    roles: ['security-officer'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const OFFICER = [
  PERMISSIONS.TEMPORARY_PASS_CREATE,
  PERMISSIONS.TEMPORARY_PASS_VERIFY,
  PERMISSIONS.GATE_OPERATE,
  PERMISSIONS.GATE_LOG_VIEW,
];
const SUPERVISOR = [...OFFICER, PERMISSIONS.TEMPORARY_PASS_REVOKE];

const officer = () => ctx(new mongoose.Types.ObjectId().toHexString(), OFFICER);
const supervisor = () => ctx(new mongoose.Types.ObjectId().toHexString(), SUPERVISOR);
const admin = () => ctx(new mongoose.Types.ObjectId().toHexString(), ['*']);

async function makeEstate(overrides: Record<string, unknown> = {}) {
  return EstateModel.create({
    name: 'Palm Grove',
    slug: `palm-${Math.random().toString(36).slice(2)}`,
    address: { line1: '1 Palm Ave', city: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    contact: { email: 'a@b.com', phone: '+2348000000000' },
    status: 'active',
    settings: { temporaryPassMaxDurationDays: 30, ...overrides },
  });
}

async function makeMembership(estate: mongoose.Types.ObjectId) {
  const email = `s${Math.random().toString(36).slice(2)}@example.com`;
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

  return MembershipModel.create({
    estateId: estate,
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });
}

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());
  await TemporaryPassModel.syncIndexes();
  await GateModel.syncIndexes();

  const estate = await makeEstate();
  estateId = estate._id.toHexString();

  const membership = await makeMembership(estate._id);
  sponsorMembershipId = membership._id.toHexString();

  const gate = await gateService.create(admin(), { name: 'Main Gate', code: 'MAIN' });
  gateId = gate._id.toHexString();
});

afterEach(() => {
  setCache(undefined);
  events.removeAllHandlers();
});

function passInput(overrides: Record<string, unknown> = {}) {
  return {
    sponsorMembershipId,
    holderName: 'Tunde Bakare',
    holderPhone: '+2348055555555',
    company: 'Bakare Plumbing',
    purpose: 'Bathroom refit, three days',
    validUntil: new Date(Date.now() + 3 * 86_400_000),
    ...overrides,
  };
}

describe('issuing', () => {
  it('issues a bounded, reusable credential', async () => {
    const { pass, token } = await temporaryPassService.issue(officer(), passInput());

    expect(pass.status).toBe('active');
    expect(pass.useCount).toBe(0);
    expect(pass.inside).toBe(false);
    expect(token).toMatch(/^v1\./);
  });

  it('uses a code an officer can read aloud without ambiguity', async () => {
    for (let index = 0; index < 20; index++) {
      const { pass } = await temporaryPassService.issue(officer(), passInput());
      expect(pass.code).toHaveLength(6);
      expect(pass.code).not.toMatch(/[O0I1S5]/);
    }
  });

  // The bound is the point. Without it this is just a resident credential.
  it('honours the estate maximum duration', async () => {
    await expect(
      temporaryPassService.issue(
        officer(),
        passInput({ validUntil: new Date(Date.now() + 90 * 86_400_000) }),
      ),
    ).rejects.toThrow(/may not exceed 30 days/);
  });

  it('rejects a window that closes before it opens', async () => {
    await expect(
      temporaryPassService.issue(
        officer(),
        passInput({
          validFrom: new Date(Date.now() + 86_400_000),
          validUntil: new Date(Date.now() + 3_600_000),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('requires temporaryPass.create', async () => {
    await expect(
      temporaryPassService.issue(
        ctx(new mongoose.Types.ObjectId().toHexString(), [PERMISSIONS.TEMPORARY_PASS_VERIFY]),
        passInput(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the issue in the audit trail', async () => {
    await temporaryPassService.issue(officer(), passInput());
    expect(await AuditLogModel.countDocuments({ action: 'temporary_pass.issued' })).toBe(1);
  });
});

describe('reuse within the window', () => {
  // This is the whole distinction from a visitor or an exit pass.
  it('admits the same holder day after day on one pass', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());
    const id = pass._id.toHexString();

    for (let day = 0; day < 3; day++) {
      const entered = await temporaryPassService.recordUse(officer(), id, {
        gateId,
        direction: 'in',
      });
      expect(entered.status).toBe('active');
      expect(entered.inside).toBe(true);

      const left = await temporaryPassService.recordUse(officer(), id, {
        gateId,
        direction: 'out',
      });
      expect(left.status).toBe('active');
      expect(left.inside).toBe(false);
    }

    const final = await TemporaryPassModel.findById(pass._id).lean();
    expect(final?.useCount).toBe(6);
    expect(final?.status).toBe('active');

    // Still usable at the gate after six passages.
    const verify = await temporaryPassService.verifyAtGate(officer(), pass.code);
    expect(verify.usable).toBe(true);
  });

  it('logs every passage, not just the first', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());
    const id = pass._id.toHexString();

    await temporaryPassService.recordUse(officer(), id, { gateId, direction: 'in' });
    await temporaryPassService.recordUse(officer(), id, { gateId, direction: 'out' });
    await temporaryPassService.recordUse(officer(), id, { gateId, direction: 'in' });

    const movements = await MovementModel.find({ subjectId: pass._id })
      .sort({ occurredAt: 1 })
      .lean();

    expect(movements.map((movement) => movement.direction)).toEqual(['in', 'out', 'in']);
    expect(movements.every((movement) => movement.subject === 'temporary-pass')).toBe(true);
  });

  it('refuses a second entry for a holder already inside', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());
    const id = pass._id.toHexString();

    await temporaryPassService.recordUse(officer(), id, { gateId, direction: 'in' });

    await expect(
      temporaryPassService.recordUse(officer(), id, { gateId, direction: 'in' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses an exit for a holder who is not inside', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());

    await expect(
      temporaryPassService.recordUse(officer(), pass._id.toHexString(), {
        gateId,
        direction: 'out',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('stops working once the window closes', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());
    await temporaryPassService.recordUse(officer(), pass._id.toHexString(), {
      gateId,
      direction: 'in',
    });
    await temporaryPassService.recordUse(officer(), pass._id.toHexString(), {
      gateId,
      direction: 'out',
    });

    await TemporaryPassModel.updateOne(
      { _id: pass._id },
      { $set: { validUntil: new Date(Date.now() - 60_000) } },
    );

    const verify = await temporaryPassService.verifyAtGate(officer(), pass.code);
    expect(verify.usable).toBe(false);
    expect(verify.message).toMatch(/expired/);

    await expect(
      temporaryPassService.recordUse(officer(), pass._id.toHexString(), {
        gateId,
        direction: 'in',
      }),
    ).rejects.toThrow(/expired/);
  });

  it('is not usable before its window opens', async () => {
    const { pass } = await temporaryPassService.issue(
      officer(),
      passInput({
        validFrom: new Date(Date.now() + 86_400_000),
        validUntil: new Date(Date.now() + 3 * 86_400_000),
      }),
    );

    const verify = await temporaryPassService.verifyAtGate(officer(), pass.code);
    expect(verify.usable).toBe(false);
    expect(verify.message).toMatch(/not valid yet/);
  });

  it('expires lapsed passes in a sweep', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());
    await TemporaryPassModel.updateOne(
      { _id: pass._id },
      { $set: { validUntil: new Date(Date.now() - 60_000) } },
    );

    expect(await temporaryPassService.expireLapsed(admin())).toBe(1);
    expect((await TemporaryPassModel.findById(pass._id).lean())?.status).toBe('expired');
  });
});

describe('revoking', () => {
  it('stops a pass mid-window and kills its credential', async () => {
    const { pass, token } = await temporaryPassService.issue(officer(), passInput());

    const revoked = await temporaryPassService.revoke(
      supervisor(),
      pass._id.toHexString(),
      'Job finished early',
    );
    expect(revoked.status).toBe('revoked');

    const verify = await temporaryPassService.verifyAtGate(officer(), pass.code);
    expect(verify.usable).toBe(false);

    const scan = await gateService.processScan(officer(), { token, gateId, direction: 'in' });
    expect(scan.admitted).toBe(false);
    expect(scan.reason).toBe('revoked');
  });

  it('requires temporaryPass.revoke', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());

    await expect(
      temporaryPassService.revoke(officer(), pass._id.toHexString(), 'x'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses to revoke twice', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());
    await temporaryPassService.revoke(supervisor(), pass._id.toHexString(), 'Done');

    await expect(
      temporaryPassService.revoke(supervisor(), pass._id.toHexString(), 'Done again'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('tenant isolation', () => {
  it('does not find a pass from another estate', async () => {
    const { pass } = await temporaryPassService.issue(officer(), passInput());

    const otherEstate = await makeEstate();
    const outsider = ctx(
      new mongoose.Types.ObjectId().toHexString(),
      SUPERVISOR,
      otherEstate._id.toHexString(),
    );

    // 404, never 403.
    await expect(
      temporaryPassRepository.findByIdOrFail(outsider, pass._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      temporaryPassService.recordUse(outsider, pass._id.toHexString(), {
        gateId,
        direction: 'in',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      temporaryPassService.revoke(outsider, pass._id.toHexString(), 'x'),
    ).rejects.toMatchObject({ statusCode: 404 });

    const verify = await temporaryPassService.verifyAtGate(outsider, pass.code);
    expect(verify.usable).toBe(false);
    expect(verify.pass).toBeNull();
  });

  it('lists only the caller estate passes', async () => {
    await temporaryPassService.issue(officer(), passInput());

    const otherEstate = await makeEstate();
    const otherMembership = await makeMembership(otherEstate._id);
    const otherContext = ctx(
      new mongoose.Types.ObjectId().toHexString(),
      OFFICER,
      otherEstate._id.toHexString(),
    );

    await temporaryPassService.issue(otherContext, {
      ...passInput(),
      sponsorMembershipId: otherMembership._id.toHexString(),
    });

    expect((await temporaryPassService.list(officer(), {})).total).toBe(1);
    expect((await temporaryPassService.list(otherContext, {})).total).toBe(1);
  });
});
