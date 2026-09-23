/**
 * Readable names for the codes `/api/v1/plans` returns.
 *
 * The API sends codes rather than prose so the server-side entitlement gate and
 * this page cannot drift. The ordering here is the order of the comparison
 * table: the rows Starter already has come first, so what each tier adds reads
 * downwards.
 */
export const FEATURE_ORDER = [
  'core',
  'billing',
  'safety',
  'sms',
  'custom-roles',
  'reports',
  'multi-estate',
  'api-access',
  'devices',
  'sso',
  'white-label',
  'audit-export',
] as const;

export type FeatureCode = (typeof FEATURE_ORDER)[number];

export const FEATURE_LABELS: Record<FeatureCode, { label: string; detail: string }> = {
  core: {
    label: 'Residents, vehicles, visitors and the gate',
    detail: 'The register, visitor passes, gate check-in and resident IDs.',
  },
  billing: {
    label: 'Dues, invoices and the ledger',
    detail: 'Recurring fees, estate-wide invoicing, Paystack collection, receipts.',
  },
  safety: {
    label: 'Incidents, emergencies and requests',
    detail: 'Emergency alerts, incident triage with SLAs, maintenance requests.',
  },
  sms: { label: 'SMS notifications', detail: 'Alerts to residents without the app installed.' },
  'custom-roles': {
    label: 'Custom roles and permissions',
    detail: 'Define who can approve residents, void invoices or blacklist a vehicle.',
  },
  reports: { label: 'Reports and exports', detail: 'Scheduled reports and spreadsheet exports.' },
  'multi-estate': {
    label: 'Multiple estates',
    detail: 'One account across several estates, with figures rolled up.',
  },
  'api-access': { label: 'API access and webhooks', detail: 'API keys and outbound webhooks.' },
  devices: { label: 'Gate hardware', detail: 'RFID readers, number-plate cameras and boom gates.' },
  sso: { label: 'Single sign-on', detail: 'SAML or OIDC against your existing directory.' },
  'white-label': { label: 'White label', detail: 'Your estate’s name and branding throughout.' },
  'audit-export': { label: 'Audit log export', detail: 'The full audit trail, exported on demand.' },
};

export const LIMIT_ORDER = ['units', 'gates', 'adminSeats', 'smsCreditsPerMonth'] as const;

export type LimitCode = (typeof LIMIT_ORDER)[number];

export const LIMIT_LABELS: Record<LimitCode, string> = {
  units: 'Units',
  gates: 'Gates',
  adminSeats: 'Admin seats',
  smsCreditsPerMonth: 'SMS credits per month',
};

export function isFeatureCode(value: string): value is FeatureCode {
  return (FEATURE_ORDER as readonly string[]).includes(value);
}
