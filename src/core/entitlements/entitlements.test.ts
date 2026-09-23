/**
 * Plan entitlements.
 *
 * The properties that matter commercially (a feature is not served to a plan
 * that did not buy it) and operationally (an unpaid estate keeps its gate).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import {
  PLANS,
  UNLIMITED,
  assertFeature,
  assertWithinLimit,
  entitlementsFor,
  invalidateEntitlements,
  resolveEntitlements,
  type EntitlementSource,
} from './index';

beforeEach(() => setCache(new MemoryCacheAdapter()));
afterEach(() => setCache(undefined));

describe('resolving a plan', () => {
  it('runs a trial at Professional', () => {
    const entitlements = resolveEntitlements({ status: 'trial' });

    // Trialling a cut-down product shows a prospect the cheap plan, which is
    // the opposite of the point.
    expect(entitlements.planCode).toBe('trial');
    expect(entitlements.features).toEqual(new Set(PLANS.professional.features));
  });

  it('gives Starter only the core features', () => {
    const entitlements = resolveEntitlements({ status: 'active', planCode: 'starter' });

    expect(entitlements.features.has('core')).toBe(true);
    expect(entitlements.features.has('billing')).toBe(false);
    expect(entitlements.features.has('safety')).toBe(false);
  });

  it('gives Enterprise everything Professional has', () => {
    const professional = resolveEntitlements({ status: 'active', planCode: 'professional' });
    const enterprise = resolveEntitlements({ status: 'active', planCode: 'enterprise' });

    for (const feature of professional.features) {
      expect(enterprise.features.has(feature)).toBe(true);
    }
    expect(enterprise.features.has('sso')).toBe(true);
  });

  // A data gap must not lock out a paying customer; the smallest plan is the
  // smallest blast radius.
  it('falls back to Starter when no plan is recorded', () => {
    expect(resolveEntitlements({ status: 'active' }).planCode).toBe('starter');
    expect(resolveEntitlements({ status: 'active', planCode: null }).planCode).toBe('starter');
  });
});

describe('an estate that has not paid', () => {
  // Cutting an estate off entirely means residents queuing at a barrier that
  // will not open, which turns a billing problem into a safety one.
  it.each(['past-due', 'suspended'] as const)('is read-only when %s', (status) => {
    expect(resolveEntitlements({ status, planCode: 'professional' }).readOnly).toBe(true);
  });

  it.each(['trial', 'active'] as const)('is writable when %s', (status) => {
    expect(resolveEntitlements({ status, planCode: 'professional' }).readOnly).toBe(false);
  });

  it('keeps its features while read-only, so reads still work', () => {
    const entitlements = resolveEntitlements({ status: 'past-due', planCode: 'professional' });
    expect(entitlements.features.has('billing')).toBe(true);
  });
});

describe('feature gating', () => {
  it('refuses a feature the plan does not include', () => {
    const starter = resolveEntitlements({ status: 'active', planCode: 'starter' });

    expect(() => assertFeature(starter, 'core')).not.toThrow();
    expect(() => assertFeature(starter, 'billing')).toThrow(/does not include/i);
  });

  it('refuses with 402, not 403', () => {
    const starter = resolveEntitlements({ status: 'active', planCode: 'starter' });

    // A distinct status, because "upgrade to continue" and "you may not do
    // this" are different answers and the client shows different things.
    try {
      assertFeature(starter, 'sso');
      expect.unreachable();
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(402);
    }
  });
});

describe('limits', () => {
  it('refuses once the ceiling is reached', () => {
    const starter = resolveEntitlements({ status: 'active', planCode: 'starter' });

    expect(() => assertWithinLimit(starter, 'units', 99)).not.toThrow();
    // At the ceiling, not over it: the check runs before the insert, so 100
    // existing units means the next one would be the 101st.
    expect(() => assertWithinLimit(starter, 'units', 100)).toThrow(/allows 100/);
  });

  it('never refuses an unlimited plan', () => {
    const enterprise = resolveEntitlements({ status: 'active', planCode: 'enterprise' });

    expect(enterprise.limits.units).toBe(UNLIMITED);
    expect(() => assertWithinLimit(enterprise, 'units', 1_000_000)).not.toThrow();
  });
});

describe('caching', () => {
  it('loads once and serves the rest from cache', async () => {
    let loads = 0;
    const load = async (): Promise<EntitlementSource> => {
      loads++;
      return { status: 'active', planCode: 'professional' };
    };

    await entitlementsFor('estate-1', load);
    await entitlementsFor('estate-1', load);

    expect(loads).toBe(1);
  });

  it('reloads after invalidation, so a plan change takes effect', async () => {
    let plan: EntitlementSource = { status: 'active', planCode: 'starter' };
    const load = async () => plan;

    expect((await entitlementsFor('estate-2', load)).planCode).toBe('starter');

    plan = { status: 'active', planCode: 'enterprise' };
    await invalidateEntitlements('estate-2');

    expect((await entitlementsFor('estate-2', load)).planCode).toBe('enterprise');
  });

  it('keeps estates separate', async () => {
    await entitlementsFor('estate-a', async () => ({ status: 'active', planCode: 'enterprise' }));
    const b = await entitlementsFor('estate-b', async () => ({
      status: 'active',
      planCode: 'starter',
    }));

    expect(b.planCode).toBe('starter');
  });

  // The caller is already authenticated against the estate, so this is a data
  // problem; a 500 on every request is a worse answer than a reduced one.
  it('falls back rather than throwing when the estate is missing', async () => {
    const entitlements = await entitlementsFor('gone', async () => null);
    expect(entitlements.planCode).toBe('starter');
    expect(entitlements.readOnly).toBe(false);
  });
});

describe('the pricing table', () => {
  it('prices annual at ten months, so two are free', () => {
    for (const plan of [PLANS.starter, PLANS.professional, PLANS.enterprise]) {
      expect(plan.annualMonthsCharged).toBe(10);
    }
  });

  it('increases in price as it increases in capability', () => {
    expect(PLANS.starter.pricePerUnitMonthlyMinor).toBeLessThan(
      PLANS.professional.pricePerUnitMonthlyMinor,
    );
    expect(PLANS.professional.pricePerUnitMonthlyMinor).toBeLessThan(
      PLANS.enterprise.pricePerUnitMonthlyMinor,
    );
  });

  it('prices in whole minor units', () => {
    for (const plan of Object.values(PLANS)) {
      expect(Number.isInteger(plan.pricePerUnitMonthlyMinor)).toBe(true);
    }
  });
});
