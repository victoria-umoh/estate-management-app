import {
  Globe,
  AlertTriangle,
  BadgeCheck,
  Banknote,
  BarChart3,
  Bell,
  Building2,
  Car,
  ClipboardList,
  FileText,
  Home,
  IdCard,
  Megaphone,
  ScanLine,
  Settings,
  ShieldCheck,
  Siren,
  Users,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PERMISSIONS } from '@/core/rbac';

/**
 * Navigation definition.
 *
 * Each item declares the permission required to reach it, and the shell hides
 * anything the viewer cannot use. This is presentation only — every route
 * enforces its own permission server-side. Hiding a link the user cannot use
 * keeps the interface honest; it is not what keeps them out.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Any one of these grants visibility. Omitted means always visible. */
  permissions?: string[];
  /** Live count badge, resolved by the shell. */
  badgeKey?: 'pendingApprovals' | 'openIncidents' | 'activeEmergencies' | 'unreadNotifications';
  /**
   * Named in the product but not yet built.
   *
   * Kept in this list rather than deleted, because the navigation doubles as
   * the statement of what this product is. Hidden from the rendered menu by
   * `visibleNavigation`, so nobody clicks through to a 404 — a menu that
   * promises screens which do not exist is worse than a shorter menu.
   */
  planned?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    title: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: Home },
      {
        label: 'Announcements',
        href: '/announcements',
        icon: Megaphone,
        permissions: [PERMISSIONS.ANNOUNCEMENT_VIEW],
      },
      {
        label: 'Notifications',
        href: '/notifications',
        icon: Bell,
        badgeKey: 'unreadNotifications',
      },
    ],
  },
  {
    title: 'My estate',
    items: [
      { label: 'My property', href: '/my/property', icon: Building2 },
      { label: 'My household', href: '/my/household', icon: Users },
      {
        label: 'My vehicles',
        href: '/my/vehicles',
        icon: Car,
        permissions: [PERMISSIONS.VEHICLE_VIEW],
      },
      {
        label: 'Visitor passes',
        href: '/my/visitors',
        icon: IdCard,
        permissions: [PERMISSIONS.VISITOR_VIEW],
      },
      {
        label: 'Exit passes',
        href: '/my/exit-passes',
        icon: FileText,
        permissions: [PERMISSIONS.EXIT_PASS_VIEW],
      },
      {
        label: 'Dues & payments',
        href: '/my/payments',
        icon: Banknote,
        permissions: [PERMISSIONS.INVOICE_VIEW],
      },
      { label: 'Digital ID', href: '/my/id', icon: BadgeCheck },
    ],
  },
  {
    title: 'Security',
    items: [
      // The scanner is first: it is the screen an officer opens most.
      {
        label: 'Gate scanner',
        href: '/security/scan',
        icon: ScanLine,
        permissions: [PERMISSIONS.GATE_OPERATE],
      },
      {
        label: 'Security desk',
        href: '/security',
        icon: ShieldCheck,
        permissions: [PERMISSIONS.GATE_OPERATE, PERMISSIONS.GATE_LOG_VIEW],
      },
      {
        label: 'Passes',
        href: '/security/passes',
        icon: FileText,
        permissions: [PERMISSIONS.EXIT_PASS_VERIFY, PERMISSIONS.TEMPORARY_PASS_VERIFY],
      },
      {
        label: 'Gate activity',
        href: '/security/activity',
        icon: ClipboardList,
        permissions: [PERMISSIONS.GATE_LOG_VIEW],
      },
      {
        label: 'Emergencies',
        href: '/security/emergencies',
        icon: Siren,
        permissions: [PERMISSIONS.EMERGENCY_VIEW],
        badgeKey: 'activeEmergencies',
      },
    ],
  },
  {
    title: 'Management',
    items: [
      {
        label: 'Residents',
        href: '/admin/residents',
        icon: Users,
        permissions: [PERMISSIONS.RESIDENT_VIEW],
        badgeKey: 'pendingApprovals',
      },
      {
        label: 'Properties',
        href: '/admin/properties',
        icon: Building2,
        permissions: [PERMISSIONS.PROPERTY_VIEW],
      },
      {
        label: 'Vehicles',
        href: '/admin/vehicles',
        icon: Car,
        permissions: [PERMISSIONS.VEHICLE_VERIFY],
      },
      {
        label: 'Incidents',
        href: '/admin/incidents',
        icon: AlertTriangle,
        permissions: [PERMISSIONS.INCIDENT_VIEW],
        badgeKey: 'openIncidents',
      },
      {
        label: 'Announcements',
        href: '/admin/announcements',
        icon: Megaphone,
        permissions: [PERMISSIONS.ANNOUNCEMENT_CREATE],
      },
      {
        label: 'Service requests',
        href: '/admin/requests',
        icon: Wrench,
        permissions: [PERMISSIONS.SERVICE_REQUEST_VIEW],
      },
      {
        label: 'Finance',
        href: '/admin/finance',
        icon: Banknote,
        permissions: [PERMISSIONS.LEDGER_VIEW],
      },
      {
        label: 'Reports',
        href: '/admin/reports',
        icon: BarChart3,
        permissions: [PERMISSIONS.REPORT_VIEW],
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        label: 'Audit trail',
        href: '/admin/audit',
        icon: ClipboardList,
        permissions: [PERMISSIONS.AUDIT_VIEW],
      },
      {
        label: 'Roles',
        href: '/admin/roles',
        icon: ShieldCheck,
        permissions: [PERMISSIONS.ROLE_VIEW],
      },
      {
        label: 'Billing',
        href: '/admin/billing',
        icon: Banknote,
        permissions: [PERMISSIONS.SUBSCRIPTION_VIEW],
      },
      {
        label: 'Settings',
        href: '/admin/settings',
        icon: Settings,
        permissions: [PERMISSIONS.ESTATE_SETTINGS_MANAGE],
      },
    ],
  },
  {
    title: 'Platform',
    items: [
      {
        label: 'All estates',
        href: '/platform',
        icon: Globe,
        permissions: [PERMISSIONS.PLATFORM_ESTATE_VIEW],
      },
    ],
  },
];

/** Drop sections and items the viewer has no permission to see, and anything not yet built. */
export function visibleNavigation(permissions: ReadonlySet<string>): NavSection[] {
  const allowed = (item: NavItem) =>
    !item.planned &&
    (!item.permissions ||
      permissions.has('*') ||
      item.permissions.some((permission) => permissions.has(permission)));

  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter(allowed),
  })).filter((section) => section.items.length > 0);
}
