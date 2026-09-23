/**
 * The platform console.
 *
 * This is the one module allowed to read across the tenant boundary, so the
 * tests are mostly about who is refused rather than what is returned.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { EstateModel } from '@/modules/estate';
import { PropertyModel } from '@/modules/property';
import { platformService } from './service';

setupTestDatabase();

/** Platform staff: the permission *and* the flag. */
function staff(permissions: string[] = ['*']): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId: new mongoose.Types.ObjectId().toHexString(),
    roles: ['super-admin'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: true,
  };
}

/** An estate role that has somehow acquired a platform permission string. */
function impostor(): RequestContext {
  return { ...staff(), roles: ['estate-chairman'], isPlatformAdmin: false };
}

async function makeEstate(overrides: Record<string, unknown> = {}) {
  return EstateModel.create({
    name: `Estate ${Math.random().toString(36).slice(2, 8)}`,
    slug: `e-${Math.random().toString(36).slice(2, 10)}`,
    address: { line1: '1 Road', city: 'Lagos', state: 'Lagos', country: 'Nigeria' },
    contact: { email: 'chair@example.com', phone: '+2348000000000' },
    status: 'trial',
    settings: {
      visitorOverstayGraceMinutes: 60,
      visitorPassMaxDurationDays: 7,
      requireResidentApproval: true,
      requireNinVerification: false,
      requireExitPassApproval: true,
      temporaryPassMaxDurationDays: 30,
      allowLandlordTenantRegistration: true,
    },
    ...overrides,
  });
}

beforeEach(() => setCache(new MemoryCacheAdapter()));
afterEach(() => setCache(undefined));

describe('who may use the platform console', () => {
  // The permission alone is not enough. `isPlatformAdmin` comes from the user
  // record, so a custom estate role that acquired a `platform.*` string is
  // still refused.
  it.each([
    ['overview', (c: RequestContext) => platformService.overview(c)],
    ['listEstates', (c: RequestContext) => platformService.listEstates(c)],
  ])('refuses %s to a non-platform caller holding the permission', async (_name, call) => {
    await expect(call(impostor())).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses suspension to a non-platform caller', async () => {
    const estate = await makeEstate();

    await expect(
      platformService.setSuspended(impostor(), estate._id.toHexString(), true, 'because'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a platform user without the specific permission', async () => {
    await expect(
      platformService.listEstates(staff([PERMISSIONS.PLATFORM_ANALYTICS_VIEW])),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the overview', () => {
  it('counts estates by status', async () => {
    await Promise.all([
      makeEstate({ status: 'trial' }),
      makeEstate({ status: 'active', planCode: 'starter' }),
      makeEstate({ status: 'past-due', planCode: 'starter' }),
      makeEstate({ status: 'suspended', planCode: 'professional' }),
    ]);

    const overview = await platformService.overview(staff());

    expect(overview.estates.total).toBe(4);
    expect(overview.estates.trial).toBe(1);
    expect(overview.estates.active).toBe(1);
    expect(overview.estates.pastDue).toBe(1);
    expect(overview.estates.suspended).toBe(1);
  });

  // Counting trials as revenue is how a board deck describes money nobody has
  // agreed to pay.
  it('counts only active estates towards MRR', async () => {
    const trial = await makeEstate({ status: 'trial' });
    const active = await makeEstate({ status: 'active', planCode: 'starter' });

    await PropertyModel.insertMany(
      [trial._id, active._id].flatMap((estateId) =>
        Array.from({ length: 10 }, (_, index) => ({
          estateId,
          unitNumber: `U${index}`,
          street: 'Road',
          type: 'detached',
          occupancyStatus: 'vacant',
          currentOccupantCount: 0,
        })),
      ),
    );

    const overview = await platformService.overview(staff());

    // Ten units on Starter only; the trial contributes nothing.
    expect(overview.mrrMinor).toBe(10 * 25_000);
  });

  it('flags estates expiring within a fortnight', async () => {
    await makeEstate({ status: 'trial', trialEndsAt: new Date(Date.now() + 3 * 86_400_000) });
    await makeEstate({ status: 'trial', trialEndsAt: new Date(Date.now() + 40 * 86_400_000) });

    expect((await platformService.overview(staff())).expiringSoon).toBe(1);
  });
});

describe('listing estates', () => {
  it('returns every estate, across tenants', async () => {
    await Promise.all([makeEstate(), makeEstate(), makeEstate()]);

    expect((await platformService.listEstates(staff())).length).toBe(3);
  });

  it('filters by status', async () => {
    await makeEstate({ status: 'active', planCode: 'starter' });
    await makeEstate({ status: 'trial' });

    const active = await platformService.listEstates(staff(), { status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe('active');
  });

  // A supplied string must not become a pattern.
  it('treats a regex metacharacter as a literal', async () => {
    await makeEstate({ name: 'Palm Grove' });

    expect(await platformService.listEstates(staff(), { search: '.*' })).toHaveLength(0);
  });

  // A support engineer needs to know an estate is near suspension; they do not
  // need its residents' names, and this module cannot give them.
  it('returns counts and status, never resident records', async () => {
    await makeEstate();
    const [summary] = await platformService.listEstates(staff());

    expect(summary).toBeDefined();
    const keys = Object.keys(summary!);
    for (const leaked of ['residentsList', 'members', 'nin', 'phone', 'occupants']) {
      expect(keys).not.toContain(leaked);
    }
    expect(typeof summary!.residents).toBe('number');
  });
});

describe('suspending an estate', () => {
  it('suspends and restores', async () => {
    const estate = await makeEstate({ status: 'active', planCode: 'starter' });
    const id = estate._id.toHexString();

    await platformService.setSuspended(staff(), id, true, 'Non-payment after grace');
    expect((await EstateModel.findById(id).lean())?.status).toBe('suspended');

    await platformService.setSuspended(staff(), id, false, 'Paid');
    expect((await EstateModel.findById(id).lean())?.status).toBe('active');
  });

  it('refuses to suspend twice, or restore what is not suspended', async () => {
    const estate = await makeEstate({ status: 'active', planCode: 'starter' });
    const id = estate._id.toHexString();

    await platformService.setSuspended(staff(), id, true, 'reason');
    await expect(platformService.setSuspended(staff(), id, true, 'again')).rejects.toMatchObject({
      statusCode: 409,
    });

    const other = await makeEstate({ status: 'active', planCode: 'starter' });
    await expect(
      platformService.setSuspended(staff(), other._id.toHexString(), false, 'reason'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('404s on an unknown estate', async () => {
    await expect(
      platformService.setSuspended(
        staff(),
        new mongoose.Types.ObjectId().toHexString(),
        true,
        'reason',
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * Platform staff acting on a customer's account is exactly the access that
   * must be reconstructable afterwards — and the chairman should see it in
   * their own trail without needing access to the platform log.
   */
  it('records the action in both the platform and the estate trail', async () => {
    const estate = await makeEstate({ status: 'active', planCode: 'starter' });
    const id = estate._id.toHexString();

    await platformService.setSuspended(staff(), id, true, 'Non-payment');

    const entries = await AuditLogModel.find({ resourceId: id }).lean();
    const actions = entries.map((entry) => entry.action);

    expect(actions).toContain('platform.estate_suspended');
    expect(actions).toContain('estate.suspended_by_platform');

    const estateEntry = entries.find((e) => e.action === 'estate.suspended_by_platform');
    expect(estateEntry?.estateId?.toHexString()).toBe(id);
  });

  it('audits a read of the estate list', async () => {
    await makeEstate();
    await platformService.listEstates(staff());

    expect(await AuditLogModel.countDocuments({ action: 'platform.estates_listed' })).toBe(1);
  });
});
