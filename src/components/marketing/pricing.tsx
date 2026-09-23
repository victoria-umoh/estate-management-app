'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Check, Minus } from 'lucide-react';
import { api } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  FEATURE_LABELS,
  FEATURE_ORDER,
  LIMIT_LABELS,
  LIMIT_ORDER,
  isFeatureCode,
  type LimitCode,
} from './plan-labels';

/**
 * Pricing, rendered from `/api/v1/plans`.
 *
 * Fetched rather than hardcoded so the page cannot advertise a feature the
 * server-side entitlement gate does not grant. Two details of that payload
 * drive most of the code here: prices are integer kobo, divided by 100 only at
 * render; and unlimited ceilings arrive as `null`, because `Infinity` is not
 * valid JSON.
 */
interface ApiPlan {
  code: string;
  name: string;
  description: string;
  pricePerUnitMonthlyMinor: number;
  annualMonthsCharged: number;
  features: string[];
  limits: Record<string, number | null>;
  highlighted: boolean;
}

type Cycle = 'monthly' | 'annual';

const naira = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });

function formatNaira(minor: number): string {
  return `₦${naira.format(Math.round(minor / 100))}`;
}

/** What one unit costs per month under the chosen cycle. */
function monthlyRate(plan: ApiPlan, cycle: Cycle): number {
  if (cycle === 'monthly') return plan.pricePerUnitMonthlyMinor;
  return (plan.pricePerUnitMonthlyMinor * plan.annualMonthsCharged) / 12;
}

function formatLimit(value: number | null): string {
  return value === null ? 'Unlimited' : naira.format(value);
}

function Tick({ on, label }: { on: boolean; label: string }) {
  return (
    <>
      {on ? (
        <Check className="text-success mx-auto size-4" aria-hidden />
      ) : (
        <Minus className="text-muted-foreground mx-auto size-4" aria-hidden />
      )}
      <span className="sr-only">{label}</span>
    </>
  );
}

export function Pricing() {
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cycle, setCycle] = useState<Cycle>('annual');

  const load = useCallback(async () => {
    try {
      setFailed(false);
      setPlans(await api.get<ApiPlan[]>('/plans'));
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <ErrorState
        title="Could not load pricing"
        description="The plans are served by the app itself, so this usually clears on a retry."
        onRetry={() => void load()}
      />
    );
  }

  // Every purchasable plan charges ten months for a year, so the saving is the
  // same sentence for all of them; read it off the data anyway rather than
  // writing "two months free" into the markup.
  const monthsCharged = plans?.find((plan) => plan.annualMonthsCharged > 0)?.annualMonthsCharged;
  const monthsFree = monthsCharged === undefined ? 2 : 12 - monthsCharged;

  return (
    <div className="space-y-12">
      <div className="flex flex-col items-start gap-5">
        <div
          role="radiogroup"
          aria-label="Billing cycle"
          className="bg-muted inline-flex items-center gap-0.5 rounded-lg p-0.5"
        >
          {(['monthly', 'annual'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={cycle === option}
              onClick={() => setCycle(option)}
              className={cn(
                'focus-visible:outline-ring rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                cycle === option
                  ? 'bg-background text-foreground shadow-subtle'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option}
            </button>
          ))}
        </div>

        {cycle === 'annual' && monthsFree > 0 ? (
          <Badge tone="success">
            {monthsFree} months free — a year is billed as {monthsCharged} months
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {plans === null
          ? [0, 1, 2].map((key) => <Skeleton key={key} className="h-80 rounded-xl" />)
          : plans.map((plan) => {
              const rate = monthlyRate(plan, cycle);
              const annualTotal = plan.pricePerUnitMonthlyMinor * plan.annualMonthsCharged;

              return (
                <Card
                  key={plan.code}
                  className={cn(
                    'flex h-full flex-col',
                    plan.highlighted && 'border-primary ring-primary/25 ring-1',
                  )}
                >
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">{plan.name}</CardTitle>
                      {plan.highlighted ? <Badge tone="primary">Recommended</Badge> : null}
                    </div>
                    <CardDescription className="text-pretty">{plan.description}</CardDescription>
                  </CardHeader>

                  <CardContent className="flex flex-1 flex-col gap-5">
                    <div>
                      <p className="text-3xl font-semibold tracking-tight tabular-nums">
                        {formatNaira(rate)}
                        <span className="text-muted-foreground ml-1.5 text-sm font-normal">
                          per unit / month
                        </span>
                      </p>
                      <p className="text-muted-foreground mt-1 text-sm tabular-nums">
                        {cycle === 'annual'
                          ? `${formatNaira(annualTotal)} per unit, billed yearly`
                          : 'Billed monthly'}
                      </p>
                    </div>

                    <dl className="space-y-1.5 text-sm">
                      {LIMIT_ORDER.map((limit) => (
                        <div key={limit} className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">{LIMIT_LABELS[limit]}</dt>
                          <dd className="font-medium tabular-nums">
                            {formatLimit(plan.limits[limit] ?? null)}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    <ul className="space-y-1.5 text-sm">
                      {plan.features.filter(isFeatureCode).map((feature) => (
                        <li key={feature} className="flex gap-2">
                          <Check className="text-success mt-0.5 size-4 shrink-0" aria-hidden />
                          <span>{FEATURE_LABELS[feature].label}</span>
                        </li>
                      ))}
                    </ul>

                    <Button
                      asChild
                      block
                      className="mt-auto"
                      variant={plan.highlighted ? 'primary' : 'outline'}
                    >
                      <Link href="/login">Start with {plan.name}</Link>
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {plans === null ? null : (
        <section aria-labelledby="compare" className="space-y-4">
          <h2 id="compare" className="text-xl font-semibold tracking-tight">
            What each plan includes
          </h2>

          {/* The table is genuinely tabular and cannot collapse to a list
              without losing the row-by-row comparison that is the point, so it
              scrolls inside its own box rather than pushing the page wide. */}
          <div className="border-border overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <caption className="sr-only">
                Features and limits included in each EstateOS plan
              </caption>
              <thead>
                <tr className="border-border bg-muted/60 border-b">
                  <th scope="col" className="px-4 py-3 text-left font-medium">
                    Feature
                  </th>
                  {plans.map((plan) => (
                    <th key={plan.code} scope="col" className="px-3 py-3 text-center font-medium">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {LIMIT_ORDER.map((limit: LimitCode) => (
                  <tr key={limit} className="border-border border-b">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      {LIMIT_LABELS[limit]}
                    </th>
                    {plans.map((plan) => (
                      <td
                        key={plan.code}
                        className="px-3 py-3 text-center font-medium tabular-nums"
                      >
                        {formatLimit(plan.limits[limit] ?? null)}
                      </td>
                    ))}
                  </tr>
                ))}

                {FEATURE_ORDER.map((feature) => (
                  <tr key={feature} className="border-border border-b last:border-0">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <span className="block">{FEATURE_LABELS[feature].label}</span>
                      <span className="text-muted-foreground block text-xs">
                        {FEATURE_LABELS[feature].detail}
                      </span>
                    </th>
                    {plans.map((plan) => (
                      <td key={plan.code} className="px-3 py-3 text-center">
                        <Tick
                          on={plan.features.includes(feature)}
                          label={`${FEATURE_LABELS[feature].label}: ${
                            plan.features.includes(feature) ? 'included' : 'not included'
                          } in ${plan.name}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
