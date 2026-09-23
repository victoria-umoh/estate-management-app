'use client';

import { useCallback, useEffect, useState } from 'react';
import { Building2, CalendarClock, CreditCard, Lock, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { api, ApiRequestError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * What the estate is on, what it is using, and what that costs.
 *
 * Two things are treated as headline rather than detail. A trial has a date on
 * which the estate stops being able to change anything, so the countdown leads
 * the page. And a lapsed estate is not a dead estate — reads keep working and
 * the gate keeps opening, only writes stop — which is said plainly at the top,
 * because the alternative is a chairman who thinks the barrier has failed.
 *
 * `limits` arrive as null for unlimited: `Infinity` is not valid JSON, so the
 * server sends null and the label is applied here. A null is never compared
 * against usage.
 */
type Limits = Record<'units' | 'gates' | 'adminSeats', number | null>;

interface Subscription {
  planCode: string;
  planName: string;
  status: string;
  billingPeriod: 'monthly' | 'annual' | null;
  trialEndsAt: string | null;
  subscriptionEndsAt: string | null;
  daysRemaining: number | null;
  readOnly: boolean;
  usage: Record<'units' | 'gates' | 'adminSeats', number>;
  limits: Limits;
  estimatedMonthlyMinor: number;
}

interface Plan {
  code: 'starter' | 'professional' | 'enterprise';
  name: string;
  description: string;
  pricePerUnitMonthlyMinor: number;
  annualMonthsCharged: number;
  features: string[];
  limits: Record<string, number | null>;
  highlighted: boolean;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  trial: 'info',
  active: 'success',
  'past-due': 'warning',
  suspended: 'danger',
};

const LIMIT_LABEL: Record<'units' | 'gates' | 'adminSeats', string> = {
  units: 'Units',
  gates: 'Gates',
  adminSeats: 'Admin seats',
};

const FEATURE_LABEL: Record<string, string> = {
  core: 'Residents, vehicles, visitors and the gate',
  billing: 'Dues, invoicing and the ledger',
  safety: 'Incidents, emergencies and exit passes',
  sms: 'SMS notifications',
  'custom-roles': 'Custom roles',
  reports: 'Reports and exports',
  'multi-estate': 'Multi-estate groups',
  'api-access': 'API keys and webhooks',
  devices: 'RFID, ANPR and boom gates',
  sso: 'Single sign-on',
  'white-label': 'White-label branding',
  'audit-export': 'Audit export',
};

export default function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [subscriptionResult, planResult] = await Promise.all([
        api.get<Subscription>('/subscription'),
        api.get<Plan[]>('/plans'),
      ]);

      setSubscription(subscriptionResult);
      setPlans(planResult);
      setFailed(false);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function changePlan(plan: Plan, billingPeriod: 'monthly' | 'annual') {
    setRefusal(null);

    try {
      const updated = await api.post<Subscription>(
        '/subscription',
        { planCode: plan.code, billingPeriod },
        // A retried change after a timeout must not be billed twice.
        { idempotencyKey: `plan-${plan.code}-${billingPeriod}-${Date.now()}` },
      );

      setSubscription(updated);
      toast.success(`Now on ${updated.planName}`);
    } catch (caught) {
      // The server refuses a downgrade the estate has outgrown and says exactly
      // why. Swallowing that leaves a chairman clicking a button that silently
      // does nothing.
      const message =
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not change the plan. Please try again.';
      setRefusal(message);
      toast.error(message);
    }
  }

  if (denied) return <PermissionDeniedState action="view billing" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Billing</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {subscription === null ? (
        <Card>
          <CardContent className="p-5">
            <SkeletonText lines={4} />
          </CardContent>
        </Card>
      ) : (
        <>
          {subscription.status === 'trial' && subscription.daysRemaining !== null && (
            <Card className="border-info">
              <CardContent className="flex flex-wrap items-center gap-4 p-5">
                <span className="bg-info-muted text-info grid size-12 shrink-0 place-items-center rounded-full">
                  <CalendarClock className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-2xl leading-none font-semibold tabular-nums">
                    {subscription.daysRemaining} {subscription.daysRemaining === 1 ? 'day' : 'days'}{' '}
                    of trial left
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    The trial runs at Professional and ends{' '}
                    {subscription.trialEndsAt ? formatDate(subscription.trialEndsAt) : 'soon'}. Pick
                    a plan before then and nothing changes for your residents.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {subscription.readOnly && (
            <Card className="border-danger">
              <CardContent className="flex items-start gap-3 p-5">
                <ShieldAlert className="text-danger mt-0.5 size-5 shrink-0" aria-hidden />
                <div>
                  <p className="text-danger font-medium">
                    This estate is {subscription.status} — changes are paused
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Everything still <strong>reads</strong>. The gate opens, passes verify,
                    residents and vehicles are all still visible. What has stopped is writing: new
                    records, edits and approvals are refused until a plan is active again. Nothing
                    has been deleted.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              icon={<CreditCard aria-hidden />}
              label="Plan"
              value={subscription.planName}
              foot={
                subscription.billingPeriod
                  ? `billed ${subscription.billingPeriod}`
                  : 'no billing period set'
              }
            />
            <Tile
              icon={<ShieldAlert aria-hidden />}
              label="Status"
              value={subscription.status}
              tone={STATUS_TONE[subscription.status] ?? 'neutral'}
            />
            <Tile
              icon={<CalendarClock aria-hidden />}
              label={subscription.status === 'trial' ? 'Trial ends in' : 'Renews in'}
              value={
                subscription.daysRemaining === null
                  ? '—'
                  : `${subscription.daysRemaining} ${subscription.daysRemaining === 1 ? 'day' : 'days'}`
              }
              foot={
                subscription.subscriptionEndsAt
                  ? formatDate(subscription.subscriptionEndsAt)
                  : subscription.trialEndsAt
                    ? formatDate(subscription.trialEndsAt)
                    : undefined
              }
            />
            <Tile
              icon={<Building2 aria-hidden />}
              label="Estimated monthly"
              value={formatMoney(subscription.estimatedMonthlyMinor)}
              foot={`${subscription.usage.units} ${subscription.usage.units === 1 ? 'unit' : 'units'}`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Usage against this plan</CardTitle>
              <CardDescription>
                Units are what the estate is billed on. A limit reached does not stop the gate — it
                stops new records of that kind.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(['units', 'gates', 'adminSeats'] as const).map((key) => (
                <UsageBar
                  key={key}
                  label={LIMIT_LABEL[key]}
                  used={subscription.usage[key]}
                  limit={subscription.limits[key]}
                />
              ))}
            </CardContent>
          </Card>

          {refusal && (
            <Alert tone="danger">
              <span className="flex items-start gap-2">
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{refusal}</span>
              </span>
            </Alert>
          )}

          <div>
            <h2 className="mb-3 text-lg font-semibold tracking-tight">Plans</h2>
            {plans === null ? (
              <SkeletonText lines={3} />
            ) : (
              <div className="grid gap-3 lg:grid-cols-3">
                {plans.map((plan) => (
                  <PlanCard
                    key={plan.code}
                    plan={plan}
                    current={subscription.planCode === plan.code}
                    units={subscription.usage.units}
                    readOnly={subscription.readOnly}
                    onChange={(period) => changePlan(plan, period)}
                  />
                ))}
              </div>
            )}
            <p className="text-muted-foreground mt-3 text-xs">
              Annual billing charges ten months, so two are free. A downgrade the estate has already
              outgrown is refused, with the figure that refused it — remove the extra gates or units
              first.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  current,
  units,
  readOnly,
  onChange,
}: {
  plan: Plan;
  current: boolean;
  units: number;
  readOnly: boolean;
  onChange: (period: 'monthly' | 'annual') => Promise<void>;
}) {
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');

  const monthly = units * plan.pricePerUnitMonthlyMinor;
  const annual = units * plan.pricePerUnitMonthlyMinor * plan.annualMonthsCharged;

  return (
    <Card
      className={cn(current && 'border-success', !current && plan.highlighted && 'border-info')}
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {plan.name}
          {current && (
            <Badge tone="success" size="sm">
              current
            </Badge>
          )}
          {!current && plan.highlighted && (
            <Badge tone="info" size="sm">
              recommended
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{plan.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {formatMoney(plan.pricePerUnitMonthlyMinor)}
            <span className="text-muted-foreground text-sm font-normal"> / unit / month</span>
          </p>
          <p className="text-muted-foreground mt-1 text-xs tabular-nums">
            {formatMoney(period === 'monthly' ? monthly : annual)} for this estate&apos;s {units}{' '}
            {units === 1 ? 'unit' : 'units'}, {period === 'monthly' ? 'per month' : 'per year'}
          </p>
        </div>

        <ul className="space-y-1 text-sm">
          {(['units', 'gates', 'adminSeats'] as const).map((key) => (
            <li key={key} className="text-muted-foreground flex justify-between gap-2">
              <span>{LIMIT_LABEL[key]}</span>
              <span className="text-foreground tabular-nums">
                {formatLimit(plan.limits[key] ?? null)}
              </span>
            </li>
          ))}
        </ul>

        <ul className="text-muted-foreground space-y-1 text-xs">
          {plan.features.map((feature) => (
            <li key={feature}>· {FEATURE_LABEL[feature] ?? feature}</li>
          ))}
        </ul>

        <div className="bg-muted flex rounded-md p-0.5" role="group" aria-label="Billing period">
          {(['monthly', 'annual'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
              className={cn(
                'h-9 flex-1 rounded text-sm font-medium transition-colors',
                period === value
                  ? 'bg-background text-foreground shadow-subtle'
                  : 'text-muted-foreground',
              )}
            >
              {value === 'monthly' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>

        <ConfirmDialog
          trigger={
            <Button block variant={current ? 'outline' : 'primary'} disabled={readOnly}>
              {current ? 'Change billing period' : `Move to ${plan.name}`}
            </Button>
          }
          title={`Move to ${plan.name}, billed ${period}?`}
          description={`This estate will be charged ${formatMoney(period === 'monthly' ? monthly : annual)} ${period === 'monthly' ? 'per month' : 'per year'} at ${units} ${units === 1 ? 'unit' : 'units'}. If the plan allows fewer units or gates than the estate already has, the change is refused and nothing is billed.`}
          confirmLabel="Change plan"
          cancelLabel="Back"
          onConfirm={() => onChange(period)}
        />

        {readOnly && (
          <p className="text-muted-foreground text-xs">
            Plan changes are paused while the estate is past due. Contact support to settle the
            account.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  // null is unlimited, not zero: a ratio against it would be meaningless, so
  // there is no bar at all in that case.
  const unlimited = limit === null;
  const ratio = unlimited || limit === 0 ? 0 : Math.min(1, used / limit);
  const tone = ratio >= 1 ? 'danger' : ratio >= 0.85 ? 'warning' : 'success';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {used} of {formatLimit(limit)}
        </span>
      </div>
      <div className="bg-muted mt-1.5 h-2 overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full',
            unlimited && 'bg-muted-foreground/30',
            !unlimited && tone === 'success' && 'bg-success',
            !unlimited && tone === 'warning' && 'bg-warning',
            !unlimited && tone === 'danger' && 'bg-danger',
          )}
          style={{ width: unlimited ? '100%' : `${Math.max(2, ratio * 100)}%` }}
        />
      </div>
      {!unlimited && ratio >= 1 && (
        <p className="text-danger mt-1 text-xs">
          At the limit. New {label.toLowerCase()} are refused until the plan changes.
        </p>
      )}
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  foot,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  foot?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4 pt-4">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
            tone === 'success' && 'bg-success-muted text-success',
            tone === 'info' && 'bg-info-muted text-info',
            tone === 'warning' && 'bg-warning-muted text-warning',
            tone === 'danger' && 'bg-danger-muted text-danger',
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg leading-tight font-semibold tabular-nums">{value}</p>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{label}</p>
          {foot && <p className="text-muted-foreground mt-0.5 truncate text-xs">{foot}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function formatLimit(limit: number | null): string {
  return limit === null ? 'Unlimited' : String(limit);
}

/** Minor units in, naira out. Division happens here and nowhere near the data. */
function formatMoney(minorUnits: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
