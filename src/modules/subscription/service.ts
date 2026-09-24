import {
  GRACE_DAYS,
  PLANS,
  TRIAL_DAYS,
  invalidateEntitlements,
  type PlanCode,
} from '@/core/entitlements';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { events } from '@/core/events';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { EstateModel, estateRepository } from '@/modules/estate';
import { MembershipModel } from '@/modules/membership/schema';
import { PropertyModel } from '@/modules/property';

const log = createLogger('subscription');

export interface SubscriptionView {
  planCode: PlanCode;
  planName: string;
  status: string;
  billingPeriod: 'monthly' | 'annual' | null;
  trialEndsAt: Date | null;
  subscriptionEndsAt: Date | null;
  daysRemaining: number | null;
  readOnly: boolean;
  /** What the estate is billed on, and what it is currently using. */
  usage: { units: number; gates: number; adminSeats: number };
  limits: { units: number; gates: number; adminSeats: number };
  /**
   * The feature flags this plan carries.
   *
   * Exposed so a screen can decline to offer an action the plan does not
   * include, rather than presenting a button that answers 402. The server
   * still enforces every one of these -- this list only keeps the interface
   * honest about what is on offer.
   */
  features: string[];
  /** Minor units for the current unit count, at this plan. */
  estimatedMonthlyMinor: number;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

function daysUntil(date: Date | null | undefined): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

export class SubscriptionService {
  /**
   * Begin a trial.
   *
   * Called once, when an estate is created. Idempotent by refusal rather than
   * silently extending — a second call is a bug, and resetting the clock would
   * hand out an unlimited free tier to anyone who found it.
   */
  async startTrial(estateId: string): Promise<Date> {
    const estate = await estateRepository.findById(estateId);
    if (!estate) throw new UnprocessableError('That estate does not exist.');

    if (estate.trialEndsAt) {
      throw new ConflictError('That estate has already had its trial.');
    }

    const trialEndsAt = addDays(new Date(), TRIAL_DAYS);

    await EstateModel.updateOne(
      { _id: estate._id },
      { $set: { status: 'trial', trialEndsAt, planCode: null } },
    );

    await invalidateEntitlements(estateId);
    log.info({ estateId, trialEndsAt }, 'trial started');

    return trialEndsAt;
  }

  /** What the estate is on, what it is using, and what that costs. */
  async current(context: RequestContext): Promise<SubscriptionView> {
    assertCan(context, PERMISSIONS.SUBSCRIPTION_VIEW);

    const estate = await estateRepository.findById(context.estateId);
    if (!estate) throw new UnprocessableError('That estate does not exist.');

    const plan = PLANS[estate.planCode ?? (estate.status === 'trial' ? 'trial' : 'starter')];

    const [units, adminSeats] = await Promise.all([
      PropertyModel.countDocuments({ estateId: estate._id, deletedAt: null }),
      MembershipModel.countDocuments({
        estateId: estate._id,
        status: 'active',
        category: { $in: ['estate-staff', 'security-personnel'] },
        deletedAt: null,
      }),
    ]);

    const { GateModel } = await import('@/modules/gate');
    const gates = await GateModel.countDocuments({ estateId: estate._id, deletedAt: null });

    const expiry = estate.status === 'trial' ? estate.trialEndsAt : estate.subscriptionEndsAt;

    return {
      planCode: plan.code,
      planName: plan.name,
      features: [...plan.features],
      status: estate.status,
      billingPeriod: estate.billingPeriod ?? null,
      trialEndsAt: estate.trialEndsAt ?? null,
      subscriptionEndsAt: estate.subscriptionEndsAt ?? null,
      daysRemaining: daysUntil(expiry),
      readOnly: estate.status === 'past-due' || estate.status === 'suspended',
      usage: { units, gates, adminSeats },
      limits: {
        units: plan.limits.units,
        gates: plan.limits.gates,
        adminSeats: plan.limits.adminSeats,
      },
      estimatedMonthlyMinor: units * plan.pricePerUnitMonthlyMinor,
    };
  }

  /**
   * Move an estate onto a paid plan.
   *
   * Refuses a downgrade that the estate has already outgrown. Accepting it
   * would leave properties and gates in place that the new plan does not
   * permit, and the next limit check would fail on a resident's action rather
   * than on the chairman's decision that caused it.
   */
  async subscribe(
    context: RequestContext,
    input: { planCode: Exclude<PlanCode, 'trial'>; billingPeriod: 'monthly' | 'annual' },
  ): Promise<SubscriptionView> {
    assertCan(context, PERMISSIONS.SUBSCRIPTION_MANAGE);

    const plan = PLANS[input.planCode];
    const usage = await this.current(context);

    if (usage.usage.units > plan.limits.units) {
      throw new ConflictError(
        `${plan.name} allows ${plan.limits.units} units and this estate has ${usage.usage.units}.`,
      );
    }
    if (usage.usage.gates > plan.limits.gates) {
      throw new ConflictError(
        `${plan.name} allows ${plan.limits.gates} gates and this estate has ${usage.usage.gates}.`,
      );
    }

    const months = input.billingPeriod === 'annual' ? 12 : 1;

    await EstateModel.updateOne(
      { _id: context.estateId },
      {
        $set: {
          planCode: input.planCode,
          billingPeriod: input.billingPeriod,
          status: 'active',
          subscriptionEndsAt: addDays(new Date(), months * 30),
        },
      },
    );

    await invalidateEntitlements(context.estateId);

    await auditService.record(context, {
      action: 'subscription.changed',
      resource: 'estate',
      resourceId: context.estateId,
      metadata: { planCode: input.planCode, billingPeriod: input.billingPeriod },
    });

    events.emit('subscription.activated', {
      estateId: context.estateId,
      planCode: input.planCode,
    });

    return this.current(context);
  }

  /**
   * Move estates past their expiry through the dunning ladder.
   *
   * trial/active → past-due (read-only grace) → suspended. Nothing is deleted;
   * retention is a separate, slower decision, because an estate that resolves a
   * failed card in week three should find its data where it left it.
   */
  async runDunning(): Promise<{ toGrace: number; toSuspended: number }> {
    const now = new Date();

    const expiring = await EstateModel.find(
      {
        status: { $in: ['trial', 'active'] },
        deletedAt: null,
        $or: [
          { status: 'trial', trialEndsAt: { $lt: now } },
          { status: 'active', subscriptionEndsAt: { $lt: now } },
        ],
      },
      // The expiry dates come back too, so the notification can say how long it
      // has been rather than just that something is wrong.
      { _id: 1, status: 1, trialEndsAt: 1, subscriptionEndsAt: 1 },
    ).lean();

    for (const estate of expiring) {
      await EstateModel.updateOne({ _id: estate._id }, { $set: { status: 'past-due' } });
      await invalidateEntitlements(estate._id.toHexString());

      await auditService.record(systemContext(estate._id.toHexString(), 'dunning'), {
        action: 'subscription.lapsed',
        resource: 'estate',
        resourceId: estate._id.toHexString(),
      });

      const lapsedOn = estate.status === 'trial' ? estate.trialEndsAt : estate.subscriptionEndsAt;

      // Emitted AFTER the status is written and the audit line is recorded, so
      // a chairman who clicks through from the email finds the estate in the
      // state the email describes. The bus contains handler failures, so a
      // notification that cannot be sent does not leave the estate half-lapsed.
      events.emit('subscription.lapsed', {
        estateId: estate._id.toHexString(),
        daysOverdue: lapsedOn
          ? Math.max(0, Math.floor((now.getTime() - lapsedOn.getTime()) / 86_400_000))
          : 0,
      });
    }

    // Grace is measured from when the subscription ended, not from when this
    // job happened to notice — a job that missed a day must not silently extend
    // everyone's grace by a day.
    const graceCutoff = addDays(now, -GRACE_DAYS);

    const lapsed = await EstateModel.find(
      {
        status: 'past-due',
        deletedAt: null,
        $or: [{ trialEndsAt: { $lt: graceCutoff } }, { subscriptionEndsAt: { $lt: graceCutoff } }],
      },
      { _id: 1 },
    ).lean();

    for (const estate of lapsed) {
      await EstateModel.updateOne({ _id: estate._id }, { $set: { status: 'suspended' } });
      await invalidateEntitlements(estate._id.toHexString());
    }

    const result = { toGrace: expiring.length, toSuspended: lapsed.length };
    if (result.toGrace || result.toSuspended) log.info(result, 'dunning run complete');

    return result;
  }
}

export const subscriptionService = new SubscriptionService();
