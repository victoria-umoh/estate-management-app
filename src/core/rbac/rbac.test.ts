import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@/core/tenancy';
import {
  ALL_PERMISSIONS,
  ESCALATION_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ROLES,
  assertCan,
  assertPlatformAccess,
  can,
  canAll,
  canAny,
  canGrantRank,
  getSystemRole,
  groupPermissions,
  isKnownPermission,
} from './index';

function ctx(permissions: string[], overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'u1',
    estateId: 'e1',
    roles: ['resident'],
    permissions: new Set(permissions),
    correlationId: 't',
    isPlatformAdmin: false,
    ...overrides,
  };
}

describe('permission registry', () => {
  it('uses a consistent resource.action shape', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z][a-zA-Z]*(\.[a-zA-Z][a-zA-Z]*)+$/);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('recognises known permissions and rejects invented ones', () => {
    expect(isKnownPermission('resident.view')).toBe(true);
    expect(isKnownPermission('resident.deleteEverything')).toBe(false);
    expect(isKnownPermission('*')).toBe(false);
  });

  it('groups permissions by resource for the role editor', () => {
    const groups = groupPermissions();
    expect(groups.resident).toContain(PERMISSIONS.RESIDENT_VIEW);
    expect(groups.payment).toContain(PERMISSIONS.PAYMENT_REFUND);
  });

  // Viewing a directory entry and viewing a national identity number are not
  // the same act, so they must not share a permission.
  it('separates NIN access from ordinary resident access', () => {
    expect(PERMISSIONS.RESIDENT_VIEW).not.toBe(PERMISSIONS.RESIDENT_VIEW_NIN);
  });
});

describe('can()', () => {
  it('grants a held permission and denies one not held', () => {
    const context = ctx(['resident.view']);
    expect(can(context, 'resident.view')).toBe(true);
    expect(can(context, 'resident.approve')).toBe(false);
  });

  it('honours the super-admin wildcard', () => {
    const context = ctx(['*']);
    expect(can(context, 'anything.at.all')).toBe(true);
    expect(can(context, PERMISSIONS.PAYMENT_REFUND)).toBe(true);
  });

  it('requires all, or any, as asked', () => {
    const context = ctx(['a.read', 'b.read']);
    expect(canAll(context, ['a.read', 'b.read'])).toBe(true);
    expect(canAll(context, ['a.read', 'c.read'])).toBe(false);
    expect(canAny(context, ['c.read', 'b.read'])).toBe(true);
    expect(canAny(context, ['c.read'])).toBe(false);
  });

  it('throws a 403 naming the missing permission', () => {
    expect(() => assertCan(ctx([]), 'payment.refund')).toThrow(/payment\.refund/);
    expect(() => assertCan(ctx([]), 'payment.refund')).toThrow(
      expect.objectContaining({ statusCode: 403 }) as never,
    );
  });

  it('denies an empty permission set', () => {
    expect(can(ctx([]), 'resident.view')).toBe(false);
  });
});

describe('platform access', () => {
  // Requires BOTH the flag and the permission, so a mis-seeded role alone
  // cannot open the cross-estate door.
  it('requires the platform flag as well as the permission', () => {
    const withPermissionOnly = ctx([PERMISSIONS.PLATFORM_ESTATE_VIEW]);
    expect(() =>
      assertPlatformAccess(withPermissionOnly, PERMISSIONS.PLATFORM_ESTATE_VIEW),
    ).toThrow(/platform administrators/);

    const withFlagOnly = ctx([], { isPlatformAdmin: true });
    expect(() => assertPlatformAccess(withFlagOnly, PERMISSIONS.PLATFORM_ESTATE_VIEW)).toThrow();

    const withBoth = ctx([PERMISSIONS.PLATFORM_ESTATE_VIEW], { isPlatformAdmin: true });
    expect(() => assertPlatformAccess(withBoth, PERMISSIONS.PLATFORM_ESTATE_VIEW)).not.toThrow();
  });
});

describe('rank-based escalation guard', () => {
  // Strictly less than: a manager must not clone their own authority sideways,
  // nor grant anything above themselves.
  it('permits granting strictly below own rank only', () => {
    expect(canGrantRank(70, 40)).toBe(true);
    expect(canGrantRank(70, 70)).toBe(false);
    expect(canGrantRank(70, 90)).toBe(false);
  });
});

describe('system roles', () => {
  it('defines every expected role', () => {
    const codes = SYSTEM_ROLES.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'super-admin',
        'estate-chairman',
        'estate-manager',
        'finance-admin',
        'security-admin',
        'security-officer',
        'homeowner',
        'tenant',
        'resident',
        'dependant',
        'contractor',
      ]),
    );
  });

  it('grants the wildcard only to the platform super-admin', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.code === 'super-admin') expect(role.permissions).toContain('*');
      else expect(role.permissions).not.toContain('*');
    }
  });

  it('uses only registered permissions', () => {
    for (const role of SYSTEM_ROLES) {
      for (const permission of role.permissions as readonly string[]) {
        if (permission === '*') continue;
        expect(isKnownPermission(permission)).toBe(true);
      }
    }
  });

  // The gate is the estate's most physically exposed terminal — often shared,
  // frequently unattended — and identity numbers have no operational use there.
  it('withholds NIN access from every role except none', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.code === 'super-admin') continue;
      expect(role.permissions).not.toContain(PERMISSIONS.RESIDENT_VIEW_NIN);
    }
  });

  it('gives the security officer gate control but no identity or money powers', () => {
    const officer = getSystemRole('security-officer')!;

    expect(officer.permissions).toContain(PERMISSIONS.GATE_OPERATE);
    expect(officer.permissions).toContain(PERMISSIONS.VISITOR_CHECKIN);

    expect(officer.permissions).not.toContain(PERMISSIONS.RESIDENT_APPROVE);
    expect(officer.permissions).not.toContain(PERMISSIONS.RESIDENT_VIEW_NIN);
    expect(officer.permissions).not.toContain(PERMISSIONS.PAYMENT_REFUND);
    expect(officer.permissions).not.toContain(PERMISSIONS.ROLE_ASSIGN);
  });

  // Super-admin reaches it through the wildcard rather than an explicit entry,
  // so finance is the only role that names it.
  it('restricts refunds to finance, which moves money back out', () => {
    const holders = SYSTEM_ROLES.filter((r) => r.permissions.includes(PERMISSIONS.PAYMENT_REFUND));
    expect(holders.map((r) => r.code)).toEqual(['finance-admin']);

    expect(can(ctx(['*']), PERMISSIONS.PAYMENT_REFUND)).toBe(true);
    expect(
      can(
        ctx(getSystemRole('estate-chairman')!.permissions as string[]),
        PERMISSIONS.PAYMENT_REFUND,
      ),
    ).toBe(false);
  });

  it('keeps escalation permissions away from ordinary residents', () => {
    for (const code of ['resident', 'tenant', 'homeowner', 'dependant', 'contractor']) {
      const role = getSystemRole(code)!;
      for (const escalation of ESCALATION_PERMISSIONS) {
        expect(role.permissions).not.toContain(escalation);
      }
    }
  });

  it('ranks roles so authority is ordered', () => {
    const rank = (code: string) => getSystemRole(code)!.rank;
    expect(rank('super-admin')).toBeGreaterThan(rank('estate-chairman'));
    expect(rank('estate-chairman')).toBeGreaterThan(rank('estate-manager'));
    expect(rank('estate-manager')).toBeGreaterThan(rank('security-officer'));
    expect(rank('security-officer')).toBeGreaterThan(rank('resident'));
  });

  it('gives every resident-facing role the basics', () => {
    for (const code of ['resident', 'tenant', 'homeowner']) {
      const role = getSystemRole(code)!;
      expect(role.permissions).toContain(PERMISSIONS.VISITOR_CREATE);
      expect(role.permissions).toContain(PERMISSIONS.EMERGENCY_CREATE);
      expect(role.permissions).toContain(PERMISSIONS.PAYMENT_CREATE);
    }
  });

  it('gives dependants and contractors the least access', () => {
    for (const code of ['dependant', 'contractor']) {
      expect(getSystemRole(code)!.permissions.length).toBeLessThan(10);
    }
  });
});
