import { defineRoute } from '@/core/http';
import { PURCHASABLE_PLANS, UNLIMITED } from '@/core/entitlements';

/**
 * The plans an estate can buy.
 *
 * Public: the pricing page renders from this, so the marketing copy and the
 * server-side gate cannot drift. `Infinity` is not valid JSON, so unlimited
 * ceilings are sent as null and labelled by the client.
 */
export const GET = defineRoute({
  auth: false,
  handler: async () =>
    PURCHASABLE_PLANS.map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description,
      pricePerUnitMonthlyMinor: plan.pricePerUnitMonthlyMinor,
      annualMonthsCharged: plan.annualMonthsCharged,
      features: plan.features,
      limits: Object.fromEntries(
        Object.entries(plan.limits).map(([key, value]) => [
          key,
          value === UNLIMITED ? null : value,
        ]),
      ),
      highlighted: plan.highlighted ?? false,
    })),
});
