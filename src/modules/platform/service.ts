import { PLANS, invalidateEntitlements, type PlanCode } from '@/core/entitlements';
import { AuthorizationError, ConflictError, NotFoundError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { EstateModel } from '@/modules/estate';
import { MembershipModel } from '@/modules/membership/schema';
import { InvoiceModel } from '@/modules/finance';
import { PropertyModel } from '@/modules/property';

const log = createLogger('platform');

/**
 * The platform console: every estate, across tenants.
 *
 * This is the one module that deliberately reads across the tenant boundary
 * that the rest of the codebase spends its effort enforcing. Three things keep
 * that honest:
 *
 *  - It never touches `BaseRepository`, whose whole job is to make a
 *    cross-tenant query impossible. It goes to models directly, in this one
 *    named place, so an unscoped query is visible in review rather than
 *    accidental.
 *  - Every method asserts a `platform.*` permission, which no estate role
 *    holds — only platform staff.
 *  - Every method writes an audit entry. Platform staff reading a customer's
 *    data is exactly the access that must be reconstructable afterwards.
 *
 * It returns counts and status, never resident records. A support engineer
 * needs to know an estate has 140 units and is three days from suspension; they
 * do not need its residents' names, and this module cannot give them.
 */
export interface EstateSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  planCode: PlanCode | null;
  planName: string;
  billingPeriod: string | null;
  trialEndsAt: Date | null;
  subscriptionEndsAt: Date | null;
  daysRemaining: number | null;
  createdAt: Date;
  units: number;
  residents: number;
  outstandingMinor: number;
  contactEmail: string;
}

export interface PlatformOverview {
  estates: { total: number; trial: number; active: number; pastDue: number; suspended: number };
  units: number;
  residents: number;
  /** Monthly recurring revenue at list price, in minor units. */
  mrrMinor: number;
  /** Estates whose trial or subscription ends within a fortnight. */
  expiringSoon: number;
}

function daysUntil(date: Date | null | undefined): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

function assertPlatformStaff(context: RequestContext): void {
  // A permission alone is not enough here. `isPlatformAdmin` is set by the auth
  // resolver from the user record, so a custom estate role that somehow
  // acquired a `platform.*` string still cannot read across tenants.
  if (!context.isPlatformAdmin) {
    throw new AuthorizationError('This is restricted to platform staff.');
  }
}

export class PlatformService {
  async overview(context: RequestContext): Promise<PlatformOverview> {
    assertCan(context, PERMISSIONS.PLATFORM_ANALYTICS_VIEW);
    assertPlatformStaff(context);

    const estates = await EstateModel.find(
      { deletedAt: null },
      {
        status: 1,
        planCode: 1,
        trialEndsAt: 1,
        subscriptionEndsAt: 1,
      },
    ).lean();

    const [units, residents] = await Promise.all([
      PropertyModel.countDocuments({ deletedAt: null }),
      MembershipModel.countDocuments({ status: 'active', deletedAt: null }),
    ]);

    const unitsByEstate = await PropertyModel.aggregate<{ _id: unknown; count: number }>([
      { $match: { deletedAt: null } },
      { $group: { _id: '$estateId', count: { $sum: 1 } } },
    ]);
    const unitCount = new Map(unitsByEstate.map((row) => [String(row._id), row.count]));

    const fortnight = new Date(Date.now() + 14 * 86_400_000);
    let mrrMinor = 0;
    let expiringSoon = 0;

    const tally = { total: 0, trial: 0, active: 0, pastDue: 0, suspended: 0 };

    for (const estate of estates) {
      tally.total++;
      if (estate.status === 'trial') tally.trial++;
      if (estate.status === 'active') tally.active++;
      if (estate.status === 'past-due') tally.pastDue++;
      if (estate.status === 'suspended') tally.suspended++;

      // Only paying estates contribute. Counting trials as revenue is how a
      // board deck ends up describing money nobody has agreed to pay.
      if (estate.status === 'active' && estate.planCode) {
        const plan = PLANS[estate.planCode];
        mrrMinor += (unitCount.get(String(estate._id)) ?? 0) * plan.pricePerUnitMonthlyMinor;
      }

      const expiry = estate.status === 'trial' ? estate.trialEndsAt : estate.subscriptionEndsAt;
      if (expiry && expiry < fortnight) expiringSoon++;
    }

    await auditService.record(context, {
      action: 'platform.overview_viewed',
      resource: 'platform',
      resourceId: 'overview',
    });

    return { estates: tally, units, residents, mrrMinor, expiringSoon };
  }

  async listEstates(
    context: RequestContext,
    filters: { status?: string; search?: string } = {},
  ): Promise<EstateSummary[]> {
    assertCan(context, PERMISSIONS.PLATFORM_ESTATE_VIEW);
    assertPlatformStaff(context);

    const filter: Record<string, unknown> = { deletedAt: null };
    if (filters.status) filter.status = filters.status;
    if (filters.search) {
      // Anchored and escaped, so the index is usable and a supplied string
      // cannot become a pattern.
      filter.name = {
        $regex: `^${filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        $options: 'i',
      };
    }

    const estates = await EstateModel.find(filter).sort({ createdAt: -1 }).limit(200).lean();

    const summaries = await Promise.all(
      estates.map(async (estate): Promise<EstateSummary> => {
        const [units, residents, unpaid] = await Promise.all([
          PropertyModel.countDocuments({ estateId: estate._id, deletedAt: null }),
          MembershipModel.countDocuments({
            estateId: estate._id,
            status: 'active',
            deletedAt: null,
          }),
          InvoiceModel.find(
            {
              estateId: estate._id,
              status: { $in: ['issued', 'partially-paid', 'overdue'] },
              deletedAt: null,
            },
            { total: 1, amountPaid: 1 },
          ).lean(),
        ]);

        const plan = PLANS[estate.planCode ?? (estate.status === 'trial' ? 'trial' : 'starter')];
        const expiry = estate.status === 'trial' ? estate.trialEndsAt : estate.subscriptionEndsAt;

        return {
          id: estate._id.toHexString(),
          name: estate.name,
          slug: estate.slug,
          status: estate.status,
          planCode: estate.planCode ?? null,
          planName: plan.name,
          billingPeriod: estate.billingPeriod ?? null,
          trialEndsAt: estate.trialEndsAt ?? null,
          subscriptionEndsAt: estate.subscriptionEndsAt ?? null,
          daysRemaining: daysUntil(expiry),
          createdAt: estate.createdAt,
          units,
          residents,
          outstandingMinor: unpaid.reduce((sum, i) => sum + (i.total - i.amountPaid), 0),
          contactEmail: estate.contact.email,
        };
      }),
    );

    await auditService.record(context, {
      action: 'platform.estates_listed',
      resource: 'platform',
      resourceId: 'estates',
      metadata: { returned: summaries.length, ...filters },
    });

    return summaries;
  }

  /**
   * Suspend or restore an estate.
   *
   * Suspension stops writes and leaves reads working, exactly as a lapsed
   * subscription does — the gate keeps opening. Platform staff cutting an
   * estate off entirely would strand residents at a barrier, which is not a
   * remedy available for a billing dispute.
   */
  async setSuspended(
    context: RequestContext,
    estateId: string,
    suspended: boolean,
    reason: string,
  ): Promise<EstateSummary> {
    assertCan(context, PERMISSIONS.PLATFORM_ESTATE_SUSPEND);
    assertPlatformStaff(context);

    const estate = await EstateModel.findOne({ _id: estateId, deletedAt: null }).lean();
    if (!estate) throw new NotFoundError('Estate');

    if (suspended && estate.status === 'suspended') {
      throw new ConflictError('That estate is already suspended.');
    }
    if (!suspended && estate.status !== 'suspended') {
      throw new ConflictError('That estate is not suspended.');
    }

    // Restoring returns it to active rather than to whatever it was before.
    // Reconstructing the prior state from a field nobody maintains is how an
    // estate comes back from suspension still inside a trial that expired
    // months ago.
    const status = suspended ? 'suspended' : 'active';

    await EstateModel.updateOne({ _id: estate._id }, { $set: { status } });
    await invalidateEntitlements(estateId);

    await auditService.record(context, {
      action: suspended ? 'platform.estate_suspended' : 'platform.estate_restored',
      resource: 'estate',
      resourceId: estateId,
      metadata: { reason },
      before: { status: estate.status },
      after: { status },
    });

    // Also recorded inside the estate's own audit trail, so a chairman
    // reviewing what happened to their estate sees it without needing access to
    // the platform log.
    await auditService.record(systemContext(estateId, 'platform'), {
      action: suspended ? 'estate.suspended_by_platform' : 'estate.restored_by_platform',
      resource: 'estate',
      resourceId: estateId,
      metadata: { reason },
    });

    log.warn({ estateId, status, reason }, 'estate status changed by platform staff');

    const [summary] = await this.listEstates(context, { search: estate.name });
    if (!summary) throw new NotFoundError('Estate');

    return summary;
  }
}

export const platformService = new PlatformService();
