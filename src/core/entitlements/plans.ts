/**
 * What each plan includes.
 *
 * The source of truth for both the pricing page and the server-side gate, so
 * the two cannot drift — a plan that markets a feature it does not grant is a
 * support ticket, and one that grants a feature it does not market is lost
 * revenue.
 *
 * Prices are integer minor units (kobo) per month, per the money convention
 * used everywhere else.
 */
export type PlanCode = 'trial' | 'starter' | 'professional' | 'enterprise';

/**
 * Gateable capabilities.
 *
 * Deliberately coarse. A feature flag per endpoint would be unmaintainable and
 * would make the pricing page unreadable; these map to the rows a buyer
 * actually compares.
 */
export type Feature =
  | 'core' // residents, properties, vehicles, visitors, gate, announcements, ID
  | 'billing' // dues, invoicing, collections, ledger, receipts
  | 'safety' // incidents, emergencies, service requests, exit passes
  | 'sms' // SMS notifications
  | 'custom-roles'
  | 'reports' // exports and scheduled reports
  | 'multi-estate'
  | 'api-access' // API keys and outbound webhooks
  | 'devices' // RFID, ANPR, boom gates
  | 'sso'
  | 'white-label'
  | 'audit-export';

export type Limit = 'units' | 'gates' | 'adminSeats' | 'smsCreditsPerMonth';

export interface Plan {
  code: PlanCode;
  name: string;
  description: string;
  /** Minor units per unit per month. Zero for the trial. */
  pricePerUnitMonthlyMinor: number;
  /** Annual billing is priced at ten months, so two are free. */
  annualMonthsCharged: number;
  features: readonly Feature[];
  limits: Readonly<Record<Limit, number>>;
  /** Shown as the recommended option on the pricing page. */
  highlighted?: boolean;
}

/** No ceiling. Compared with `>=`, so a real number is never accidentally infinite. */
export const UNLIMITED = Number.POSITIVE_INFINITY;

const CORE: readonly Feature[] = ['core'];
const PROFESSIONAL: readonly Feature[] = [
  'core',
  'billing',
  'safety',
  'sms',
  'custom-roles',
  'reports',
];

export const PLANS: Readonly<Record<PlanCode, Plan>> = {
  /**
   * The 30-day trial runs at Professional.
   *
   * Trialling a cut-down product tells a prospect what the cheap plan is like,
   * which is the opposite of the point. The unit cap is what keeps it from
   * being used as a free tier indefinitely.
   */
  trial: {
    code: 'trial',
    name: 'Trial',
    description: '30 days of Professional, no card required.',
    pricePerUnitMonthlyMinor: 0,
    annualMonthsCharged: 0,
    features: PROFESSIONAL,
    limits: { units: 100, gates: 4, adminSeats: 10, smsCreditsPerMonth: 100 },
  },

  starter: {
    code: 'starter',
    name: 'Starter',
    description: 'Residents, vehicles, visitors and the gate.',
    pricePerUnitMonthlyMinor: 25_000,
    annualMonthsCharged: 10,
    features: CORE,
    limits: { units: 100, gates: 1, adminSeats: 2, smsCreditsPerMonth: 0 },
  },

  professional: {
    code: 'professional',
    name: 'Professional',
    description: 'Everything in Starter, plus dues, safety and reporting.',
    pricePerUnitMonthlyMinor: 45_000,
    annualMonthsCharged: 10,
    features: PROFESSIONAL,
    limits: { units: 500, gates: 4, adminSeats: 10, smsCreditsPerMonth: 1000 },
    highlighted: true,
  },

  enterprise: {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Multi-estate groups, devices, SSO and white-label.',
    pricePerUnitMonthlyMinor: 70_000,
    annualMonthsCharged: 10,
    features: [
      ...PROFESSIONAL,
      'multi-estate',
      'api-access',
      'devices',
      'sso',
      'white-label',
      'audit-export',
    ],
    limits: {
      units: UNLIMITED,
      gates: UNLIMITED,
      adminSeats: UNLIMITED,
      smsCreditsPerMonth: 5000,
    },
  },
};

export const PURCHASABLE_PLANS: readonly Plan[] = [
  PLANS.starter,
  PLANS.professional,
  PLANS.enterprise,
];

/** Days of full access before a trial expires. */
export const TRIAL_DAYS = 30;

/**
 * Days of read-only access after a trial or subscription lapses.
 *
 * An estate that forgets to pay must not lose the gate — the consequence of
 * cutting off access is that residents queue at a barrier that will not open,
 * which is a safety problem rather than a billing one. Reads keep working;
 * writes stop.
 */
export const GRACE_DAYS = 14;

/** Days data is retained after suspension before it may be purged. */
export const RETENTION_DAYS = 90;
