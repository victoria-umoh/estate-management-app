/**
 * The permission registry.
 *
 * Every permission the platform recognises is declared here, in one place, so
 * that "what can this role do?" is answerable by reading a file rather than by
 * grepping for authorisation checks.
 *
 * Format is `resource.action`. Names are a stable contract — they are stored on
 * role documents in the database and embedded in issued access tokens, so
 * renaming one silently strips the permission from every role and token that
 * references it. Add new names; do not repurpose old ones.
 *
 * Granularity follows risk, not symmetry. `resident.view` and
 * `resident.viewNin` are separate because seeing a directory entry and seeing
 * someone's national identity number are not the same act, even though both are
 * "reading a resident".
 */
export const PERMISSIONS = {
  // --- Residents & identity -------------------------------------------------
  /** The estate directory: names, codes, unit numbers. Held by every resident. */
  RESIDENT_VIEW: 'resident.view',
  /**
   * A resident's full record, including contact details.
   *
   * Separate from `resident.view` for the third time in this codebase, after
   * `invoice.viewAll` and `incident.viewAll`. Residents hold the narrow one so
   * the directory works; without the split, any resident could read any other
   * household's email, phone, date of birth, masked NIN and emergency contact.
   *
   * Not granted to a plain security officer. The gate has its own identity
   * path, and contact details have no use at a barrier.
   */
  RESIDENT_VIEW_ALL: 'resident.viewAll',
  /** Reveals a full NIN. Deliberately separate, and always audited. */
  RESIDENT_VIEW_NIN: 'resident.viewNin',
  RESIDENT_CREATE: 'resident.create',
  RESIDENT_UPDATE: 'resident.update',
  RESIDENT_APPROVE: 'resident.approve',
  RESIDENT_SUSPEND: 'resident.suspend',
  RESIDENT_DELETE: 'resident.delete',
  RESIDENT_EXPORT: 'resident.export',

  // --- Households & dependants ---------------------------------------------
  HOUSEHOLD_VIEW: 'household.view',
  HOUSEHOLD_CREATE: 'household.create',
  HOUSEHOLD_UPDATE: 'household.update',
  HOUSEHOLD_DELETE: 'household.delete',

  // --- Tenancy --------------------------------------------------------------
  TENANT_VIEW: 'tenant.view',
  TENANT_CREATE: 'tenant.create',
  TENANT_APPROVE: 'tenant.approve',
  TENANT_RENEW: 'tenant.renew',
  TENANT_EXIT: 'tenant.exit',

  // --- Properties -----------------------------------------------------------
  PROPERTY_VIEW: 'property.view',
  PROPERTY_CREATE: 'property.create',
  PROPERTY_UPDATE: 'property.update',
  PROPERTY_TRANSFER: 'property.transfer',
  PROPERTY_DELETE: 'property.delete',

  // --- Vehicles -------------------------------------------------------------
  VEHICLE_VIEW: 'vehicle.view',
  VEHICLE_CREATE: 'vehicle.create',
  VEHICLE_UPDATE: 'vehicle.update',
  VEHICLE_VERIFY: 'vehicle.verify',
  VEHICLE_BLACKLIST: 'vehicle.blacklist',
  VEHICLE_DELETE: 'vehicle.delete',

  // --- Visitors -------------------------------------------------------------
  VISITOR_VIEW: 'visitor.view',
  VISITOR_CREATE: 'visitor.create',
  VISITOR_APPROVE: 'visitor.approve',
  VISITOR_VERIFY: 'visitor.verify',
  VISITOR_CHECKIN: 'visitor.checkin',
  VISITOR_CHECKOUT: 'visitor.checkout',
  VISITOR_CANCEL: 'visitor.cancel',

  // --- Passes ---------------------------------------------------------------
  TEMPORARY_PASS_CREATE: 'temporaryPass.create',
  TEMPORARY_PASS_VERIFY: 'temporaryPass.verify',
  TEMPORARY_PASS_REVOKE: 'temporaryPass.revoke',

  EXIT_PASS_VIEW: 'exitPass.view',
  EXIT_PASS_CREATE: 'exitPass.create',
  EXIT_PASS_APPROVE: 'exitPass.approve',
  EXIT_PASS_VERIFY: 'exitPass.verify',
  EXIT_PASS_CLOSE: 'exitPass.close',

  // --- Gates & movement -----------------------------------------------------
  GATE_VIEW: 'gate.view',
  GATE_CREATE: 'gate.create',
  GATE_UPDATE: 'gate.update',
  GATE_DELETE: 'gate.delete',
  /** Work a gate: scan, admit, deny, record movement. */
  GATE_OPERATE: 'gate.operate',

  GATE_LOG_VIEW: 'gateLog.view',
  GATE_LOG_EXPORT: 'gateLog.export',

  // --- Incidents ------------------------------------------------------------
  /** Incidents you reported or are named in. Held by every resident. */
  INCIDENT_VIEW: 'incident.view',
  /**
   * Every incident in the estate.
   *
   * Separate from `incident.view` for the same reason `invoice.viewAll` is:
   * residents hold the narrow one so they can follow their own report, and
   * without the split the estate-wide list hands any resident the full
   * description and named parties of every incident on the estate.
   */
  INCIDENT_VIEW_ALL: 'incident.viewAll',
  INCIDENT_CREATE: 'incident.create',
  INCIDENT_ASSIGN: 'incident.assign',
  INCIDENT_UPDATE: 'incident.update',
  INCIDENT_RESOLVE: 'incident.resolve',
  INCIDENT_CLOSE: 'incident.close',
  INCIDENT_ESCALATE: 'incident.escalate',

  // --- Emergencies ----------------------------------------------------------
  EMERGENCY_VIEW: 'emergency.view',
  EMERGENCY_CREATE: 'emergency.create',
  EMERGENCY_ACKNOWLEDGE: 'emergency.acknowledge',
  EMERGENCY_RESOLVE: 'emergency.resolve',

  // --- Service requests -----------------------------------------------------
  SERVICE_REQUEST_VIEW: 'serviceRequest.view',
  SERVICE_REQUEST_CREATE: 'serviceRequest.create',
  SERVICE_REQUEST_ASSIGN: 'serviceRequest.assign',
  SERVICE_REQUEST_COMMENT: 'serviceRequest.comment',
  SERVICE_REQUEST_RESOLVE: 'serviceRequest.resolve',
  SERVICE_REQUEST_CLOSE: 'serviceRequest.close',

  // --- Money ----------------------------------------------------------------
  FEE_VIEW: 'fee.view',
  FEE_CREATE: 'fee.create',
  FEE_UPDATE: 'fee.update',
  FEE_DELETE: 'fee.delete',

  /** A resident's own invoices. Held by every resident. */
  INVOICE_VIEW: 'invoice.view',
  /**
   * Every invoice in the estate.
   *
   * Separate from `invoice.view` because residents hold that one to see their
   * own dues — without this split, the estate-wide list would hand any resident
   * every other household's billing history.
   */
  INVOICE_VIEW_ALL: 'invoice.viewAll',
  INVOICE_CREATE: 'invoice.create',
  INVOICE_CANCEL: 'invoice.cancel',
  INVOICE_EXPORT: 'invoice.export',

  PAYMENT_VIEW: 'payment.view',
  PAYMENT_CREATE: 'payment.create',
  PAYMENT_VERIFY: 'payment.verify',
  /** Moves money back out. Held by finance roles only. */
  PAYMENT_REFUND: 'payment.refund',
  PAYMENT_EXPORT: 'payment.export',

  LEDGER_VIEW: 'ledger.view',
  LEDGER_EXPORT: 'ledger.export',

  // --- Communication --------------------------------------------------------
  ANNOUNCEMENT_VIEW: 'announcement.view',
  ANNOUNCEMENT_CREATE: 'announcement.create',
  ANNOUNCEMENT_UPDATE: 'announcement.update',
  ANNOUNCEMENT_PUBLISH: 'announcement.publish',
  ANNOUNCEMENT_DELETE: 'announcement.delete',

  NOTIFICATION_SEND: 'notification.send',
  NOTIFICATION_TEMPLATE_MANAGE: 'notification.templateManage',

  // --- Documents ------------------------------------------------------------
  DOCUMENT_VIEW: 'document.view',
  DOCUMENT_UPLOAD: 'document.upload',
  DOCUMENT_DOWNLOAD: 'document.download',
  DOCUMENT_DELETE: 'document.delete',

  // --- Reporting ------------------------------------------------------------
  REPORT_VIEW: 'report.view',
  REPORT_GENERATE: 'report.generate',
  REPORT_SCHEDULE: 'report.schedule',
  REPORT_EXPORT: 'report.export',

  ANALYTICS_VIEW: 'analytics.view',

  // --- Administration -------------------------------------------------------
  /** Reading the audit trail. There is deliberately no write or delete. */
  AUDIT_VIEW: 'audit.view',
  AUDIT_EXPORT: 'audit.export',

  USER_VIEW: 'user.view',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_SUSPEND: 'user.suspend',
  USER_DELETE: 'user.delete',

  ROLE_VIEW: 'role.view',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',
  /** Granting roles to people — the privilege-escalation surface. */
  ROLE_ASSIGN: 'role.assign',

  ESTATE_VIEW: 'estate.view',
  ESTATE_UPDATE: 'estate.update',
  ESTATE_SETTINGS_MANAGE: 'estate.settingsManage',

  SUBSCRIPTION_VIEW: 'subscription.view',
  SUBSCRIPTION_MANAGE: 'subscription.manage',

  // --- Platform (cross-estate) ---------------------------------------------
  // Only ever held by platform staff. Every one of these reaches beyond a
  // single estate and is checked separately from the tenant guard.
  PLATFORM_ESTATE_VIEW: 'platform.estate.view',
  PLATFORM_ESTATE_CREATE: 'platform.estate.create',
  PLATFORM_ESTATE_SUSPEND: 'platform.estate.suspend',
  PLATFORM_ANALYTICS_VIEW: 'platform.analytics.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Every permission, for validation and for the admin UI. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export function isKnownPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Permissions that grant authority over authority itself.
 *
 * Anyone holding one of these can widen their own access, so assigning them is
 * always audited and is restricted to the most trusted roles.
 */
export const ESCALATION_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.ROLE_CREATE,
  PERMISSIONS.ROLE_UPDATE,
  PERMISSIONS.ROLE_DELETE,
  PERMISSIONS.ROLE_ASSIGN,
  PERMISSIONS.USER_CREATE,
  PERMISSIONS.USER_DELETE,
];

/** Group permissions by resource, for rendering the role editor. */
export function groupPermissions(): Record<string, Permission[]> {
  const groups: Record<string, Permission[]> = {};

  for (const permission of ALL_PERMISSIONS) {
    const resource = permission.split('.')[0]!;
    (groups[resource] ??= []).push(permission);
  }

  return groups;
}
