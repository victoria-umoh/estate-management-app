import { PlanRestrictionError } from '@/core/errors';
import { getCache } from '@/integrations/cache';
import { PLANS, UNLIMITED, type Feature, type Limit, type Plan, type PlanCode } from './plans';

/**
 * What an estate is currently entitled to.
 *
 * Resolved from its subscription, not asserted by the client. Every check in
 * the request path goes through here so there is one place that decides, and
 * one place to change when the pricing does.
 */
export interface Entitlements {
  planCode: PlanCode;
  features: ReadonlySet<Feature>;
  limits: Readonly<Record<Limit, number>>;
  /** Writes are refused while an estate is in grace or suspended. */
  readOnly: boolean;
  /** Null once a subscription is active. */
  trialEndsAt: Date | null;
}

/** The shape this needs from an estate. Kept narrow so `core` stays independent of `modules`. */
export interface EntitlementSource {
  status: 'trial' | 'active' | 'past-due' | 'suspended' | 'closed';
  planCode?: PlanCode | null;
  trialEndsAt?: Date | null;
}

const CACHE_PREFIX = 'entitlements:';
/**
 * Short, because a plan change must take effect promptly — an estate that has
 * just paid should not wait to regain writes. Sixty seconds is short enough to
 * feel immediate and long enough to spare the database on every request.
 */
const CACHE_TTL_SECONDS = 60;

export function resolveEntitlements(estate: EntitlementSource): Entitlements {
  const plan = planFor(estate);

  // Grace and suspension keep reads working. Cutting an estate off entirely
  // means residents queuing at a barrier that will not open, which turns a
  // billing problem into a safety one.
  const readOnly = estate.status === 'past-due' || estate.status === 'suspended';

  return {
    planCode: plan.code,
    features: new Set(plan.features),
    limits: plan.limits,
    readOnly,
    trialEndsAt: estate.status === 'trial' ? (estate.trialEndsAt ?? null) : null,
  };
}

function planFor(estate: EntitlementSource): Plan {
  if (estate.status === 'trial') return PLANS.trial;

  // An estate with no plan recorded falls back to Starter rather than to
  // nothing. Failing closed here would lock a paying customer out over a data
  // gap; the feature set is the smallest, so the blast radius is a missing
  // feature rather than a dead gate.
  return PLANS[estate.planCode ?? 'starter'] ?? PLANS.starter;
}

export function hasFeature(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features.has(feature);
}

export function assertFeature(entitlements: Entitlements, feature: Feature): void {
  if (!entitlements.features.has(feature)) {
    throw new PlanRestrictionError(`Your plan does not include this feature. Upgrade to continue.`);
  }
}

/**
 * Check a countable limit before creating something.
 *
 * Call this inside the same transaction as the insert. Checking beforehand and
 * writing afterwards leaves a window where two concurrent requests both see
 * room for one more.
 */
export function assertWithinLimit(
  entitlements: Entitlements,
  limit: Limit,
  currentCount: number,
): void {
  const ceiling = entitlements.limits[limit];
  if (ceiling === UNLIMITED) return;

  if (currentCount >= ceiling) {
    throw new PlanRestrictionError(`Your plan allows ${ceiling} ${limit}. Upgrade to add more.`);
  }
}

/** Cached lookup, for the request path. */
export async function entitlementsFor(
  estateId: string,
  load: () => Promise<EntitlementSource | null>,
): Promise<Entitlements> {
  const cache = await getCache();
  const key = `${CACHE_PREFIX}${estateId}`;

  const cached = await cache.get<EntitlementSource>(key);
  if (cached) return resolveEntitlements(cached);

  const estate = await load();
  // An unknown estate gets the smallest plan rather than an exception: the
  // caller is already authenticated against it, so this is a data problem, and
  // a 500 on every request is a worse answer than a reduced one.
  if (!estate) return resolveEntitlements({ status: 'active', planCode: 'starter' });

  await cache.set(key, estate, CACHE_TTL_SECONDS);
  return resolveEntitlements(estate);
}

export async function invalidateEntitlements(estateId: string): Promise<void> {
  await (await getCache()).delete(`${CACHE_PREFIX}${estateId}`);
}
