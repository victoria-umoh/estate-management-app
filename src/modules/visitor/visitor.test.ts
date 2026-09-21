/**
 * Visitor passes, gate operations and overstay detection.
 *
 * These exercise the full spec workflow: a resident creates a pass, the visitor
 * arrives, security scans them in, they overstay, the sweep raises it, and they
 * are finally checked out.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { runOverstaySweep } from '@/jobs/overstay-sweep';
import { VisitorPassModel } from './schema';
import { visitorPassRepository, visitorService } from './service';

setupTestDatabase();

let estateId: string;
let hostUserId: string;
let hostMembershipId: string;
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

const RESIDENT = [PERMISSIONS.VISITOR_CREATE, PERMISSIONS.VISITOR_VIEW, PERMISSIONS.VISITOR_CANCEL];
const OFFICER = [
  PERMISSIONS.GATE_OPERATE,
  PERMISSIONS.GATE_VIEW,
  PERMISSIONS.GATE_LOG_VIEW,
  PERMISSIONS.VISITOR_CHECKIN,
  PERMISSIONS.VISITOR_CHECKOUT,
  PERMISSIONS.VISITOR_VERIFY,
  PERMISSIONS.TEMPORARY_PASS_CREATE,
];

const host = () => ctx(hostUserId, RESIDENT);
const officer = () => ctx(new mongoose.Types.ObjectId().toHexString(), OFFICER);
const admin = () => ctx(new mongoose.Types.ObjectId().toHexString(), ['*']);

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());
  await VisitorPassModel.syncIndexes();
  await GateModel.syncIndexes();

  const estate = await EstateModel.create({
    name: 'Palm Grove',
    slug: `palm-${Math.random().toString(36).slice(2)}`,
    address: { line1: '1 Palm Ave', city: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    contact: { email: 'a@b.com', phone: '+2348000000000' },
    status: 'active',
    settings: { visitorOverstayGraceMinutes: 60, visitorPassMaxDurationDays: 7 },
  });
  estateId = estate._id.toHexString();

  const email = `h${Math.random().toString(36).slice(2)}@example.com`;
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
  hostUserId = user._id.toHexString();

  const membership = await MembershipModel.create({
    estateId: estate._id,
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });
  hostMembershipId = membership._id.toHexString();

  const gate = await gateService.create(admin(), { name: 'Main Gate', code: 'MAIN' });
  gateId = gate._id.toHexString();
});

afterEach(() => {
  setCache(undefined);
  events.removeAllHandlers();
});

function passInput(overrides: Record<string, unknown> = {}) {
  return {
    hostMembershipId,
    visitorName: 'Chidi Okafor',
    visitorPhone: '+2348055555555',
    purpose: 'Family visit',
    partySize: 2,
    expectedArrival: new Date(Date.now() - 60_000),
    expectedDeparture: new Date(Date.now() + 3 * 3_600_000),
    ...overrides,
  };
}

describe('creating a visitor pass', () => {
  it('issues a pass with a readable code and a working token', async () => {
    const { pass, token } = await visitorService.createPass(host(), passInput());

    expect(pass.status).toBe('pending');
    expect(pass.code).toHaveLength(6);
    expect(token).toMatch(/^v1\./);
  });

  // The code is read aloud over a phone and typed by an officer in poor light.
  it('uses an alphabet without confusable characters', async () => {
    for (let index = 0; index < 20; index++) {
      const { pass } = await visitorService.createPass(host(), passInput());
      expect(pass.code).not.toMatch(/[O0I1S5]/);
    }
  });

  it('rejects a departure before arrival', async () => {
    await expect(
      visitorService.createPass(
        host(),
        passInput({
          expectedArrival: new Date(Date.now() + 3_600_000),
          expectedDeparture: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('honours the estate maximum pass duration', async () => {
    await expect(
      visitorService.createPass(
        host(),
        passInput({ expectedDeparture: new Date(Date.now() + 30 * 86_400_000) }),
      ),
    ).rejects.toThrow(/may not exceed 7 days/);
  });

  it('refuses a resident creating a pass for another household', async () => {
    const other = await MembershipModel.create({
      estateId: new mongoose.Types.ObjectId(estateId),
      userId: new mongoose.Types.ObjectId(),
      category: 'tenant',
      status: 'active',
      roleIds: [],
    });

    await expect(
      visitorService.createPass(host(), passInput({ hostMembershipId: other._id.toHexString() })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records creation in the audit trail', async () => {
    await visitorService.createPass(host(), passInput());
    expect(await AuditLogModel.countDocuments({ action: 'visitor.pass_created' })).toBe(1);
  });
});

describe('the gate workflow', () => {
  it('runs the full spec workflow end to end', async () => {
    // Resident creates a pass.
    const { pass, token } = await visitorService.createPass(host(), passInput());

    // Visitor arrives; security scans them in.
    const entry = await gateService.processScan(officer(), {
      token,
      gateId,
      direction: 'in',
    });

    expect(entry.admitted).toBe(true);
    expect(entry.passStatus).toBe('inside');
    expect(entry.credential?.display.primaryLabel).toBe('Chidi Okafor');

    // Visitor shows as inside.
    const inside = await visitorPassRepository.findCurrentlyInside(officer());
    expect(inside).toHaveLength(1);

    // Visitor leaves; security scans them out.
    const exit = await gateService.processScan(officer(), {
      token,
      gateId,
      direction: 'out',
    });

    expect(exit.admitted).toBe(true);
    expect(exit.passStatus).toBe('completed');
    expect(await visitorPassRepository.findCurrentlyInside(officer())).toHaveLength(0);

    // Both movements recorded.
    const movements = await MovementModel.find({ subjectId: pass._id })
      .sort({ occurredAt: 1 })
      .lean();
    expect(movements.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(movements.every((m) => m.admitted)).toBe(true);
  });

  // The denials are what an investigation is usually looking for.
  it('records a denied scan as carefully as an admission', async () => {
    const result = await gateService.processScan(officer(), {
      token: 'v1.forged.signature',
      gateId,
      direction: 'in',
    });

    expect(result.admitted).toBe(false);
    expect(result.movementId).toBeTruthy();

    const movement = await MovementModel.findById(result.movementId).lean();
    expect(movement?.admitted).toBe(false);
    expect(movement?.denialReason).toBe('bad-signature');
    expect(movement?.method).toBe('qr');
  });

  it('refuses a second check-in for a visitor already inside', async () => {
    const { token } = await visitorService.createPass(host(), passInput());
    await gateService.processScan(officer(), { token, gateId, direction: 'in' });

    await expect(
      gateService.processScan(officer(), { token, gateId, direction: 'in' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // A spent code must not admit a second visit the same day.
  it('revokes the credential on checkout', async () => {
    const { token } = await visitorService.createPass(host(), passInput());
    await gateService.processScan(officer(), { token, gateId, direction: 'in' });
    await gateService.processScan(officer(), { token, gateId, direction: 'out' });

    const reuse = await gateService.processScan(officer(), { token, gateId, direction: 'in' });
    expect(reuse.admitted).toBe(false);
    expect(reuse.reason).toBe('revoked');
  });

  it('respects a gate that is closed or one-way', async () => {
    const { token } = await visitorService.createPass(host(), passInput());
    const exitOnly = await gateService.create(admin(), {
      name: 'Exit',
      code: 'EXIT',
      direction: 'exit-only',
    });

    await expect(
      gateService.processScan(officer(), {
        token,
        gateId: exitOnly._id.toHexString(),
        direction: 'in',
      }),
    ).rejects.toThrow(/exit-only/);
  });

  it('requires gate.operate', async () => {
    const { token } = await visitorService.createPass(host(), passInput());
    await expect(
      gateService.processScan(ctx(hostUserId, RESIDENT), { token, gateId, direction: 'in' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('admitting by code', () => {
  // The fallback when a QR will not scan.
  it('admits a visitor by their short code', async () => {
    const { pass } = await visitorService.createPass(host(), passInput());

    const result = await gateService.admitByCode(officer(), {
      code: pass.code.toLowerCase(),
      gateId,
      direction: 'in',
    });

    expect(result.admitted).toBe(true);
    expect(result.passStatus).toBe('inside');

    const movement = await MovementModel.findById(result.movementId).lean();
    expect(movement?.method).toBe('code');
  });

  it('records an unknown code as a denial', async () => {
    const result = await gateService.admitByCode(officer(), {
      code: 'ZZZZZZ',
      gateId,
      direction: 'in',
    });

    expect(result.admitted).toBe(false);
    const movement = await MovementModel.findById(result.movementId).lean();
    expect(movement?.admitted).toBe(false);
  });
});

describe('walk-in passes', () => {
  it('lets an officer issue a pass at the gate', async () => {
    const { pass, token } = await visitorService.issueWalkIn(officer(), {
      hostMembershipId,
      visitorName: 'Delivery Rider',
      purpose: 'Package delivery',
      hostApproved: true,
      validForHours: 2,
    });

    expect(pass.passType).toBe('walk-in');

    const result = await gateService.processScan(officer(), { token, gateId, direction: 'in' });
    expect(result.admitted).toBe(true);
  });

  // Both happen; only one of them is defensible afterwards.
  it('records whether the host was actually reached', async () => {
    await visitorService.issueWalkIn(officer(), {
      hostMembershipId,
      visitorName: 'Unannounced Visitor',
      purpose: 'Visit',
      hostApproved: false,
    });

    const entry = await AuditLogModel.findOne({ action: 'visitor.walk_in_issued' }).lean();
    expect(entry?.metadata).toMatchObject({ hostApproved: false });
  });

  it('requires the temporary pass permission', async () => {
    await expect(
      visitorService.issueWalkIn(ctx(hostUserId, RESIDENT), {
        hostMembershipId,
        visitorName: 'X',
        purpose: 'Y',
        hostApproved: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('overstay detection', () => {
  async function checkedInPassDueAt(departure: Date) {
    const { pass, token } = await visitorService.createPass(
      host(),
      passInput({ expectedDeparture: new Date(Date.now() + 3_600_000) }),
    );
    await gateService.processScan(officer(), { token, gateId, direction: 'in' });

    // Rewound after check-in, because the pass must be valid to get in.
    await VisitorPassModel.updateOne({ _id: pass._id }, { $set: { expectedDeparture: departure } });

    return pass;
  }

  it('flags a visitor past their departure plus the grace period', async () => {
    const pass = await checkedInPassDueAt(new Date(Date.now() - 2 * 3_600_000));

    const result = await runOverstaySweep();
    expect(result.flagged).toBe(1);

    const updated = await VisitorPassModel.findById(pass._id).lean();
    expect(updated?.overstayNotifiedAt).toBeInstanceOf(Date);
  });

  it('leaves a visitor still inside the grace period alone', async () => {
    // Twenty minutes late against a sixty minute grace.
    await checkedInPassDueAt(new Date(Date.now() - 20 * 60_000));
    expect((await runOverstaySweep()).flagged).toBe(0);
  });

  // A host pestered every five minutes stops reading the alerts entirely.
  it('raises each pass only once', async () => {
    await checkedInPassDueAt(new Date(Date.now() - 2 * 3_600_000));

    expect((await runOverstaySweep()).flagged).toBe(1);
    expect((await runOverstaySweep()).flagged).toBe(0);
  });

  it('honours each estate own grace period', async () => {
    // Fifteen minutes: a pass twenty minutes late now qualifies.
    await EstateModel.updateOne(
      { _id: estateId },
      { $set: { 'settings.visitorOverstayGraceMinutes': 15 } },
    );

    await checkedInPassDueAt(new Date(Date.now() - 20 * 60_000));
    expect((await runOverstaySweep()).flagged).toBe(1);
  });

  it('ignores visitors who already left', async () => {
    const { pass, token } = await visitorService.createPass(host(), passInput());
    await gateService.processScan(officer(), { token, gateId, direction: 'in' });
    await gateService.processScan(officer(), { token, gateId, direction: 'out' });

    await VisitorPassModel.updateOne(
      { _id: pass._id },
      { $set: { expectedDeparture: new Date(Date.now() - 5 * 3_600_000) } },
    );

    expect((await runOverstaySweep()).flagged).toBe(0);
  });

  it('emits an event carrying how late the visitor is', async () => {
    const handler = vi.fn();
    events.on('visitor.overstayed', handler);

    await checkedInPassDueAt(new Date(Date.now() - 2 * 3_600_000));
    await runOverstaySweep();

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler.mock.calls[0]![0].payload.minutesOver).toBeGreaterThanOrEqual(119);
  });

  it('records the overstay in the audit trail', async () => {
    await checkedInPassDueAt(new Date(Date.now() - 2 * 3_600_000));
    await runOverstaySweep();

    expect(await AuditLogModel.countDocuments({ action: 'visitor.overstayed' })).toBe(1);
  });
});

describe('cancelling', () => {
  it('cancels a pending pass and revokes its credential', async () => {
    const { pass, token } = await visitorService.createPass(host(), passInput());
    await visitorService.cancel(host(), pass._id.toHexString(), 'Plans changed');

    const result = await gateService.processScan(officer(), { token, gateId, direction: 'in' });
    expect(result.admitted).toBe(false);
  });

  it('refuses to cancel a visitor already inside', async () => {
    const { pass, token } = await visitorService.createPass(host(), passInput());
    await gateService.processScan(officer(), { token, gateId, direction: 'in' });

    await expect(visitorService.cancel(host(), pass._id.toHexString(), 'x')).rejects.toThrow(
      /already inside/,
    );
  });
});

describe('the movement log', () => {
  // This is the record consulted after a theft or a dispute.
  it('is immutable', async () => {
    const { token } = await visitorService.createPass(host(), passInput());
    const result = await gateService.processScan(officer(), { token, gateId, direction: 'in' });

    await expect(
      MovementModel.updateOne({ _id: result.movementId }, { $set: { admitted: false } }),
    ).rejects.toThrow(/immutable/i);
  });

  // A log that resolves to "unknown" once the source changes is no use at all.
  it('keeps its own copy of who passed through', async () => {
    const { pass, token } = await visitorService.createPass(host(), passInput());
    const result = await gateService.processScan(officer(), { token, gateId, direction: 'in' });

    await VisitorPassModel.deleteOne({ _id: pass._id });

    const movement = await MovementModel.findById(result.movementId).lean();
    expect(movement?.subjectLabel).toBe('Chidi Okafor');
  });
});
