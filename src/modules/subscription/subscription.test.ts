/**
 * Subscriptions and dunning.
 *
 * The properties that matter: a trial is granted once, a downgrade cannot strand
 * an estate over its new ceiling, and a lapsed estate loses writes but keeps its
 * gate.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { GRACE_DAYS, TRIAL_DAYS, resolveEntitlements } from '@/core/entitlements';
import { PERMISSIONS } from '@/core/rbac';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import type { RequestContext } from '@/core/tenancy';
import { EstateModel } from '@/modules/estate';
import { PropertyModel } from '@/modules/property';
import { subscriptionService } from './service';

setupTestDatabase();

function ctx(estateId: string, permissions: string[] = ['*']): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-chairman'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

async function makeEstate(overrides: Record<string, unknown> = {}) {
  return EstateModel.create({
    name: 'Test Estate',
    slug: `test-${Math.random().toString(36).slice(2, 10)}`,
    address: { line1: '1 Test Road', city: 'Lagos', state: 'Lagos', country: 'Nigeria' },
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

const DAY = 86_400_000;

beforeEach(() => setCache(new MemoryCacheAdapter()));
afterEach(() => setCache(undefined));

describe('starting a trial', () => {
  it('sets a window thirty days out', async () => {
    const estate = await makeEstate({ trialEndsAt: null });
    const endsAt = await subscriptionService.startTrial(estate._id.toHexString());

    const days = Math.round((endsAt.getTime() - Date.now()) / DAY);
    expect(days).toBe(TRIAL_DAYS);
  });

  // Resetting the clock on a second call hands an unlimited free tier to
  // anyone who finds the endpoint.
  it('refuses a second trial', async () => {
    const estate = await makeEstate({ trialEndsAt: new Date() });

    await expect(subscriptionService.startTrial(estate._id.toHexString())).rejects.toThrow(
      /already had its trial/,
    );
  });
});

describe('reading the current subscription', () => {
  it('reports usage against the plan ceiling', async () => {
    const estate = await makeEstate({ trialEndsAt: new Date(Date.now() + 10 * DAY) });
    const estateId = estate._id.toHexString();

    await PropertyModel.create({
      estateId: estate._id,
      unitNumber: '1A',
      street: 'Test Road',
      type: 'detached',
      occupancyStatus: 'vacant',
      currentOccupantCount: 0,
    });

    const view = await subscriptionService.current(ctx(estateId));

    expect(view.planCode).toBe('trial');
    expect(view.usage.units).toBe(1);
    expect(view.limits.units).toBe(100);
    expect(view.daysRemaining).toBe(10);
    expect(view.readOnly).toBe(false);
  });

  it('requires subscription.view', async () => {
    const estate = await makeEstate();

    await expect(
      subscriptionService.current(ctx(estate._id.toHexString(), [PERMISSIONS.ESTATE_VIEW])),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('scopes usage to one estate', async () => {
    const [a, b] = await Promise.all([makeEstate(), makeEstate()]);

    await PropertyModel.create({
      estateId: a._id,
      unitNumber: '1A',
      street: 'Test Road',
      type: 'detached',
      occupancyStatus: 'vacant',
      currentOccupantCount: 0,
    });

    expect((await subscriptionService.current(ctx(b._id.toHexString()))).usage.units).toBe(0);
  });
});

describe('changing plan', () => {
  it('moves the estate onto the plan and activates it', async () => {
    const estate = await makeEstate();
    const estateId = estate._id.toHexString();

    const view = await subscriptionService.subscribe(ctx(estateId), {
      planCode: 'professional',
      billingPeriod: 'annual',
    });

    expect(view.planCode).toBe('professional');
    expect(view.status).toBe('active');
    expect(view.billingPeriod).toBe('annual');
  });

  it('prices the estimate from the unit count', async () => {
    const estate = await makeEstate();
    const estateId = estate._id.toHexString();

    await PropertyModel.insertMany(
      Array.from({ length: 4 }, (_, index) => ({
        estateId: estate._id,
        unitNumber: `${index + 1}A`,
        street: 'Test Road',
        type: 'detached',
        occupancyStatus: 'vacant',
        currentOccupantCount: 0,
      })),
    );

    const view = await subscriptionService.subscribe(ctx(estateId), {
      planCode: 'starter',
      billingPeriod: 'monthly',
    });

    // Four units at ₦250 each.
    expect(view.estimatedMonthlyMinor).toBe(4 * 25_000);
  });

  // Accepting it would leave properties in place the new plan does not permit,
  // and the next limit check would fail on a resident's action rather than on
  // the decision that caused it.
  it('refuses a downgrade the estate has outgrown', async () => {
    const estate = await makeEstate();
    const estateId = estate._id.toHexString();

    await PropertyModel.insertMany(
      Array.from({ length: 101 }, (_, index) => ({
        estateId: estate._id,
        unitNumber: `U${index}`,
        street: 'Test Road',
        type: 'detached',
        occupancyStatus: 'vacant',
        currentOccupantCount: 0,
      })),
    );

    await expect(
      subscriptionService.subscribe(ctx(estateId), {
        planCode: 'starter',
        billingPeriod: 'monthly',
      }),
    ).rejects.toThrow(/allows 100 units/);
  });

  it('requires subscription.manage', async () => {
    const estate = await makeEstate();

    await expect(
      subscriptionService.subscribe(
        ctx(estate._id.toHexString(), [PERMISSIONS.SUBSCRIPTION_VIEW]),
        {
          planCode: 'starter',
          billingPeriod: 'monthly',
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('dunning', () => {
  it('moves an expired trial into grace, not straight to suspended', async () => {
    const estate = await makeEstate({ trialEndsAt: new Date(Date.now() - DAY) });

    const result = await subscriptionService.runDunning();
    expect(result.toGrace).toBe(1);

    const after = await EstateModel.findById(estate._id).lean();
    expect(after?.status).toBe('past-due');
  });

  it('leaves a trial that has not expired alone', async () => {
    await makeEstate({ trialEndsAt: new Date(Date.now() + 5 * DAY) });

    expect((await subscriptionService.runDunning()).toGrace).toBe(0);
  });

  it('suspends only after the grace period', async () => {
    const estate = await makeEstate({
      status: 'past-due',
      trialEndsAt: new Date(Date.now() - (GRACE_DAYS + 1) * DAY),
    });

    const result = await subscriptionService.runDunning();
    expect(result.toSuspended).toBe(1);

    expect((await EstateModel.findById(estate._id).lean())?.status).toBe('suspended');
  });

  it('keeps an estate in grace while the period runs', async () => {
    const estate = await makeEstate({
      status: 'past-due',
      trialEndsAt: new Date(Date.now() - (GRACE_DAYS - 2) * DAY),
    });

    await subscriptionService.runDunning();
    expect((await EstateModel.findById(estate._id).lean())?.status).toBe('past-due');
  });

  // The gate must keep working. Residents queuing at a barrier that will not
  // open is a safety problem, not a billing one.
  it('leaves a lapsed estate able to read', async () => {
    const entitlements = resolveEntitlements({ status: 'past-due', planCode: 'professional' });

    expect(entitlements.readOnly).toBe(true);
    expect(entitlements.features.has('core')).toBe(true);
    expect(entitlements.features.has('safety')).toBe(true);
  });

  it('is safe to run twice', async () => {
    await makeEstate({ trialEndsAt: new Date(Date.now() - DAY) });

    expect((await subscriptionService.runDunning()).toGrace).toBe(1);
    // Already past-due, so the second pass finds nothing new to demote.
    expect((await subscriptionService.runDunning()).toGrace).toBe(0);
  });
});
