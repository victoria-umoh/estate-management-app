import { PERMISSIONS, type Permission } from './permissions';

const P = PERMISSIONS;

/**
 * System roles, seeded into every estate.
 *
 * These are the defaults, not a ceiling: estates can create custom roles. They
 * cannot edit or delete these, because a chairman who accidentally strips
 * `gate.operate` from the security officer role would lock their own gates.
 *
 * Permissions are assigned by what a job actually requires. A security officer
 * can operate a gate and check visitors in and out, but cannot approve a
 * resident or see a NIN — those belong to the people who handle identity, and
 * the gate is the most physically exposed terminal in the estate.
 */
export interface SystemRoleDefinition {
  code: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** Ranking used to stop a role granting authority above its own. */
  rank: number;
}

/** Permissions every member of an estate holds, whatever their role. */
const BASE_RESIDENT: readonly Permission[] = [
  P.ANNOUNCEMENT_VIEW,
  P.ESTATE_VIEW,
  P.DOCUMENT_VIEW,
  P.DOCUMENT_UPLOAD,
  P.DOCUMENT_DOWNLOAD,
  P.SERVICE_REQUEST_VIEW,
  P.SERVICE_REQUEST_CREATE,
  P.SERVICE_REQUEST_COMMENT,
  P.INCIDENT_VIEW,
  P.INCIDENT_CREATE,
  P.EMERGENCY_CREATE,
  P.EMERGENCY_VIEW,
];

/** What a resident may do about their own household, visitors and bills. */
const RESIDENT_SELF_SERVICE: readonly Permission[] = [
  P.VISITOR_VIEW,
  P.VISITOR_CREATE,
  P.VISITOR_CANCEL,
  P.VEHICLE_VIEW,
  P.VEHICLE_CREATE,
  P.VEHICLE_UPDATE,
  P.EXIT_PASS_VIEW,
  P.EXIT_PASS_CREATE,
  P.INVOICE_VIEW,
  P.PAYMENT_VIEW,
  P.PAYMENT_CREATE,
  P.PROPERTY_VIEW,
  P.HOUSEHOLD_VIEW,
];

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    code: 'super-admin',
    name: 'Super Administrator',
    description: 'Platform operator. Full access across every estate.',
    rank: 100,
    // The wildcard is resolved in can(); it is not expanded into a token, so a
    // permission added later is covered without reissuing anything.
    permissions: ['*' as Permission],
  },
  {
    code: 'estate-chairman',
    name: 'Estate Chairman',
    description: 'Highest authority within a single estate.',
    rank: 90,
    permissions: [
      ...BASE_RESIDENT,
      ...RESIDENT_SELF_SERVICE,
      P.RESIDENT_VIEW,
      P.RESIDENT_CREATE,
      P.RESIDENT_UPDATE,
      P.RESIDENT_VIEW_ALL,
      P.RESIDENT_APPROVE,
      // resident.delete stops here and is not given to the manager: it is the
      // only one of the four that removes a person rather than a thing.
      P.RESIDENT_DELETE,
      P.RESIDENT_SUSPEND,
      P.RESIDENT_EXPORT,
      P.HOUSEHOLD_CREATE,
      P.HOUSEHOLD_UPDATE,
      P.TENANT_VIEW,
      P.TENANT_APPROVE,
      P.TENANT_CREATE,
      P.TENANT_RENEW,
      P.TENANT_EXIT,
      P.PROPERTY_CREATE,
      P.PROPERTY_UPDATE,
      // Each delete sits beside the update it completes. All four are soft and
      // audited, and each refuses while something still depends on the record,
      // so the danger is an estate unable to correct its own register rather
      // than one deleting too freely.
      P.PROPERTY_DELETE,
      P.PROPERTY_TRANSFER,
      P.VISITOR_VIEW_ALL,
      P.VEHICLE_VIEW_ALL,
      P.VEHICLE_DELETE,
      P.VEHICLE_VERIFY,
      P.VEHICLE_BLACKLIST,
      P.VISITOR_APPROVE,
      P.EXIT_PASS_APPROVE,
      P.GATE_VIEW,
      P.GATE_CREATE,
      P.GATE_UPDATE,
      P.GATE_DELETE,
      P.GATE_LOG_VIEW,
      P.GATE_LOG_EXPORT,
      P.INCIDENT_VIEW_ALL,
      P.INCIDENT_ASSIGN,
      P.INCIDENT_UPDATE,
      P.INCIDENT_RESOLVE,
      P.INCIDENT_CLOSE,
      P.INCIDENT_ESCALATE,
      P.EMERGENCY_VIEW_ALL,
      P.EMERGENCY_ACKNOWLEDGE,
      P.EMERGENCY_RESOLVE,
      P.SERVICE_REQUEST_VIEW_ALL,
      P.SERVICE_REQUEST_ASSIGN,
      P.SERVICE_REQUEST_RESOLVE,
      P.SERVICE_REQUEST_CLOSE,
      P.FEE_VIEW,
      P.FEE_CREATE,
      P.FEE_UPDATE,
      P.INVOICE_VIEW_ALL,
      P.INVOICE_CREATE,
      P.INVOICE_CANCEL,
      P.INVOICE_EXPORT,
      P.PAYMENT_VERIFY,
      P.PAYMENT_EXPORT,
      P.LEDGER_VIEW,
      P.LEDGER_EXPORT,
      P.ANNOUNCEMENT_CREATE,
      P.ANNOUNCEMENT_UPDATE,
      P.ANNOUNCEMENT_PUBLISH,
      P.ANNOUNCEMENT_DELETE,
      P.NOTIFICATION_SEND,
      P.REPORT_VIEW,
      P.REPORT_GENERATE,
      P.REPORT_SCHEDULE,
      P.REPORT_EXPORT,
      P.ANALYTICS_VIEW,
      P.AUDIT_VIEW,
      P.AUDIT_EXPORT,
      P.ROLE_VIEW,
      P.ROLE_CREATE,
      P.ROLE_UPDATE,
      P.ROLE_DELETE,
      P.ROLE_ASSIGN,
      P.ESTATE_UPDATE,
      P.ESTATE_SETTINGS_MANAGE,
      P.SUBSCRIPTION_VIEW,
      P.SUBSCRIPTION_MANAGE,
      // The chairman sees the estate-wide document register, so they get the
      // act that page offers. Every other role above the manager already had
      // this; the chairman was the gap, and the page's delete button refused
      // for the one account most likely to press it.
      P.DOCUMENT_DELETE,
      // Deliberately NOT granted: resident.viewNin. Running the estate does not
      // require reading anyone's national identity number.
    ],
  },
  {
    code: 'estate-manager',
    name: 'Estate Manager',
    description: 'Day-to-day operations: residents, properties, gates, requests.',
    rank: 70,
    permissions: [
      ...BASE_RESIDENT,
      ...RESIDENT_SELF_SERVICE,
      P.RESIDENT_VIEW,
      P.RESIDENT_CREATE,
      P.RESIDENT_UPDATE,
      P.RESIDENT_VIEW_ALL,
      P.RESIDENT_APPROVE,
      P.RESIDENT_EXPORT,
      P.HOUSEHOLD_CREATE,
      P.HOUSEHOLD_UPDATE,
      P.TENANT_VIEW,
      P.TENANT_CREATE,
      P.TENANT_APPROVE,
      P.TENANT_RENEW,
      P.TENANT_EXIT,
      P.PROPERTY_CREATE,
      P.PROPERTY_UPDATE,
      P.PROPERTY_DELETE,
      P.VISITOR_VIEW_ALL,
      P.VEHICLE_VIEW_ALL,
      P.VEHICLE_DELETE,
      P.VEHICLE_VERIFY,
      P.VISITOR_APPROVE,
      P.EXIT_PASS_APPROVE,
      P.GATE_VIEW,
      P.GATE_LOG_VIEW,
      P.INCIDENT_VIEW_ALL,
      P.INCIDENT_ASSIGN,
      P.INCIDENT_UPDATE,
      P.INCIDENT_RESOLVE,
      P.EMERGENCY_VIEW_ALL,
      P.EMERGENCY_ACKNOWLEDGE,
      P.SERVICE_REQUEST_VIEW_ALL,
      P.SERVICE_REQUEST_ASSIGN,
      P.SERVICE_REQUEST_RESOLVE,
      P.SERVICE_REQUEST_CLOSE,
      P.FEE_VIEW,
      P.INVOICE_VIEW,
      P.PAYMENT_VIEW,
      P.ANNOUNCEMENT_CREATE,
      P.ANNOUNCEMENT_UPDATE,
      P.ANNOUNCEMENT_PUBLISH,
      P.NOTIFICATION_SEND,
      P.REPORT_VIEW,
      P.REPORT_GENERATE,
      P.REPORT_EXPORT,
      P.ANALYTICS_VIEW,
      P.DOCUMENT_DELETE,
    ],
  },
  {
    code: 'finance-admin',
    name: 'Finance Administrator',
    description: 'Billing, collections and reconciliation.',
    rank: 60,
    permissions: [
      ...BASE_RESIDENT,
      P.RESIDENT_VIEW,
      P.PROPERTY_VIEW,
      P.FEE_VIEW,
      P.FEE_CREATE,
      P.FEE_UPDATE,
      P.FEE_DELETE,
      P.INVOICE_VIEW,
      P.INVOICE_VIEW_ALL,
      P.INVOICE_CREATE,
      P.INVOICE_CANCEL,
      P.INVOICE_EXPORT,
      P.PAYMENT_VIEW,
      P.PAYMENT_VERIFY,
      P.PAYMENT_REFUND,
      P.PAYMENT_EXPORT,
      P.LEDGER_VIEW,
      P.LEDGER_EXPORT,
      P.REPORT_VIEW,
      P.REPORT_GENERATE,
      P.REPORT_EXPORT,
      P.REPORT_SCHEDULE,
      P.ANALYTICS_VIEW,
      P.NOTIFICATION_SEND,
      P.SUBSCRIPTION_VIEW,
    ],
  },
  {
    code: 'security-admin',
    name: 'Security Administrator',
    description: 'Runs the security operation: gates, officers, incidents.',
    rank: 60,
    permissions: [
      ...BASE_RESIDENT,
      P.RESIDENT_VIEW,
      P.PROPERTY_VIEW,
      P.VEHICLE_VIEW,
      P.VISITOR_VIEW_ALL,
      P.VEHICLE_VIEW_ALL,
      P.VEHICLE_DELETE,
      P.VEHICLE_VERIFY,
      P.VEHICLE_BLACKLIST,
      P.VISITOR_VIEW,
      P.VISITOR_APPROVE,
      P.VISITOR_VERIFY,
      P.VISITOR_CHECKIN,
      P.VISITOR_CHECKOUT,
      P.VISITOR_CANCEL,
      P.TEMPORARY_PASS_CREATE,
      P.TEMPORARY_PASS_VERIFY,
      P.TEMPORARY_PASS_REVOKE,
      P.EXIT_PASS_VIEW,
      P.EXIT_PASS_APPROVE,
      P.EXIT_PASS_VERIFY,
      P.EXIT_PASS_CLOSE,
      P.GATE_VIEW,
      P.GATE_CREATE,
      P.GATE_UPDATE,
      P.GATE_DELETE,
      P.GATE_OPERATE,
      P.GATE_LOG_VIEW,
      P.GATE_LOG_EXPORT,
      P.INCIDENT_VIEW_ALL,
      P.INCIDENT_ASSIGN,
      P.INCIDENT_UPDATE,
      P.INCIDENT_RESOLVE,
      P.INCIDENT_CLOSE,
      P.INCIDENT_ESCALATE,
      P.EMERGENCY_VIEW_ALL,
      P.EMERGENCY_ACKNOWLEDGE,
      P.EMERGENCY_RESOLVE,
      P.REPORT_VIEW,
      P.REPORT_GENERATE,
      P.REPORT_EXPORT,
      P.ANALYTICS_VIEW,
      P.NOTIFICATION_SEND,
    ],
  },
  {
    code: 'security-officer',
    name: 'Security Officer',
    description: 'Works a gate: verifies, admits, denies and records movement.',
    rank: 40,
    permissions: [
      P.ANNOUNCEMENT_VIEW,
      P.ESTATE_VIEW,
      // Enough to confirm a person belongs here and which house they are for.
      // NOT resident.viewNin: the gate is the estate's most physically exposed
      // terminal, often shared and unattended, and identity numbers have no
      // operational use there.
      P.RESIDENT_VIEW,
      P.PROPERTY_VIEW,
      P.VEHICLE_VIEW,
      P.VISITOR_VIEW_ALL,
      P.VEHICLE_VIEW_ALL,
      P.VEHICLE_VERIFY,
      P.VISITOR_VIEW,
      P.VISITOR_VERIFY,
      P.VISITOR_CHECKIN,
      P.VISITOR_CHECKOUT,
      P.TEMPORARY_PASS_CREATE,
      P.TEMPORARY_PASS_VERIFY,
      P.EXIT_PASS_VIEW,
      P.EXIT_PASS_VERIFY,
      P.EXIT_PASS_CLOSE,
      P.GATE_VIEW,
      P.GATE_OPERATE,
      P.GATE_LOG_VIEW,
      P.INCIDENT_VIEW,
      P.INCIDENT_VIEW_ALL,
      P.INCIDENT_CREATE,
      P.INCIDENT_UPDATE,
      // An officer records incidents, so they attach and read the evidence on
      // one. This role is the only staff role that does not inherit the
      // resident baseline, which is why it alone had no document access at
      // all -- an officer could open an incident and not see its photograph.
      // NOT document.delete: recording what happened must not include
      // unrecording it.
      P.DOCUMENT_VIEW,
      P.DOCUMENT_UPLOAD,
      P.DOCUMENT_DOWNLOAD,
      P.EMERGENCY_VIEW,
      P.EMERGENCY_CREATE,
      P.EMERGENCY_VIEW_ALL,
      P.EMERGENCY_ACKNOWLEDGE,
    ],
  },
  {
    code: 'homeowner',
    name: 'Homeowner / Landlord',
    description: 'Owns property in the estate; may register tenants and household.',
    rank: 30,
    permissions: [
      ...BASE_RESIDENT,
      ...RESIDENT_SELF_SERVICE,
      P.HOUSEHOLD_CREATE,
      P.HOUSEHOLD_UPDATE,
      P.HOUSEHOLD_DELETE,
      P.TENANT_VIEW,
      P.TENANT_CREATE,
      P.TENANT_RENEW,
      P.TENANT_EXIT,
      P.RESIDENT_VIEW,
    ],
  },
  {
    code: 'tenant',
    name: 'Tenant',
    description: 'Rents a property; manages their own household and visitors.',
    rank: 20,
    permissions: [
      ...BASE_RESIDENT,
      ...RESIDENT_SELF_SERVICE,
      P.HOUSEHOLD_CREATE,
      P.HOUSEHOLD_UPDATE,
    ],
  },
  {
    code: 'resident',
    name: 'Resident',
    description: 'General resident of the estate.',
    rank: 20,
    permissions: [...BASE_RESIDENT, ...RESIDENT_SELF_SERVICE],
  },
  {
    code: 'dependant',
    name: 'Dependant',
    description: 'Household member under a resident. Read-mostly access.',
    rank: 10,
    permissions: [
      P.ANNOUNCEMENT_VIEW,
      P.ESTATE_VIEW,
      P.EMERGENCY_CREATE,
      P.INCIDENT_CREATE,
      // Can raise a visitor request; approval rests with the household head.
      P.VISITOR_VIEW,
      P.VISITOR_CREATE,
    ],
  },
  {
    code: 'contractor',
    name: 'Contractor / Vendor',
    description: 'Works in the estate temporarily. Minimal access.',
    rank: 10,
    permissions: [P.ESTATE_VIEW, P.ANNOUNCEMENT_VIEW, P.SERVICE_REQUEST_VIEW],
  },
] as const;

export const SYSTEM_ROLE_CODES = SYSTEM_ROLES.map((role) => role.code);

export function getSystemRole(code: string): SystemRoleDefinition | undefined {
  return SYSTEM_ROLES.find((role) => role.code === code);
}
