/**
 * Role management, with emphasis on privilege escalation.
 *
 * This is the main way a role system fails: an administrator who can define
 * roles can otherwise define one holding every permission and assign it to
 * themselves, making every other authorisation check decorative.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS, getSystemRole } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { blindIndex } from '@/core/crypto';
import { AuditLogModel } from '@/modules/audit';
import { SessionModel } from '@/modules/auth';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { roleRepository } from './repository';
import { RoleModel } from './schema';
import { roleService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

function ctx(permissions: string[], roles: string[] = [], estateId = ESTATE_A): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles,
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const chairman = () =>
  ctx([...(getSystemRole('estate-chairman')!.permissions as string[])], ['estate-chairman']);

beforeEach(async () => {
  await RoleModel.syncIndexes();
});

describe('seeding system roles', () => {
  it('creates every system role for an estate', async () => {
    const seeded = await roleService.seedSystemRoles(ESTATE_A);
    expect(seeded).toHaveLength(11);
    expect(await RoleModel.countDocuments({ estateId: ESTATE_A })).toBe(11);
  });

  it('is idempotent, so re-running setup is safe', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    await roleService.seedSystemRoles(ESTATE_A);
    expect(await RoleModel.countDocuments({ estateId: ESTATE_A })).toBe(11);
  });

  it('gives each estate its own copies', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    await roleService.seedSystemRoles(ESTATE_B);

    expect(await RoleModel.countDocuments({ estateId: ESTATE_A })).toBe(11);
    expect(await RoleModel.countDocuments({ estateId: ESTATE_B })).toBe(11);
  });

  it('marks them as system roles', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    expect(await RoleModel.countDocuments({ estateId: ESTATE_A, isSystem: true })).toBe(11);
  });
});

describe('resolving permissions for a token', () => {
  it('unions permissions across assigned roles', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    const estateId = new mongoose.Types.ObjectId(ESTATE_A);

    const officer = await RoleModel.findOne({ estateId, code: 'security-officer' }).lean();
    const finance = await RoleModel.findOne({ estateId, code: 'finance-admin' }).lean();

    const resolved = await roleService.resolvePermissions(estateId, [officer!._id, finance!._id]);

    expect(resolved.permissions).toContain(PERMISSIONS.GATE_OPERATE);
    expect(resolved.permissions).toContain(PERMISSIONS.PAYMENT_REFUND);
    expect(resolved.roles.sort()).toEqual(['finance-admin', 'security-officer']);
  });

  it('collapses to the wildcard for super-admin', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    const estateId = new mongoose.Types.ObjectId(ESTATE_A);
    const superAdmin = await RoleModel.findOne({ estateId, code: 'super-admin' }).lean();

    const resolved = await roleService.resolvePermissions(estateId, [superAdmin!._id]);
    // Kept small on purpose: a permission added later is covered without
    // reissuing any token.
    expect(resolved.permissions).toEqual(['*']);
  });

  it('returns nothing for a membership with no roles', async () => {
    const resolved = await roleService.resolvePermissions(
      new mongoose.Types.ObjectId(ESTATE_A),
      [],
    );
    expect(resolved.permissions).toEqual([]);
  });

  it('will not resolve roles belonging to another estate', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    const foreign = await RoleModel.findOne({ estateId: ESTATE_A, code: 'estate-chairman' }).lean();

    const resolved = await roleService.resolvePermissions(new mongoose.Types.ObjectId(ESTATE_B), [
      foreign!._id,
    ]);
    expect(resolved.permissions).toEqual([]);
  });
});

describe('privilege escalation guards', () => {
  beforeEach(async () => {
    await roleService.seedSystemRoles(ESTATE_A);
  });

  it('refuses to mint the wildcard into a custom role', async () => {
    await expect(
      roleService.createCustomRole(chairman(), {
        code: 'shadow-admin',
        name: 'Shadow Admin',
        permissions: ['*'],
        rank: 50,
      }),
    ).rejects.toThrow(/wildcard/i);
  });

  // Otherwise a manager defines a chairman-equivalent role and assigns it to
  // themselves.
  // An actor who legitimately manages roles, but ranks below the chairman.
  // (An estate-manager has no role.create at all, so it cannot exercise this
  // guard.) The seeded custom role gives it a real rank to compare against.
  async function rankedRoleManager(rank: number): Promise<RequestContext> {
    const actor = chairman();
    const role = await roleService.createCustomRole(actor, {
      code: `deputy-${rank}`,
      name: `Deputy ${rank}`,
      permissions: [PERMISSIONS.ROLE_CREATE, PERMISSIONS.ROLE_VIEW, PERMISSIONS.RESIDENT_VIEW],
      rank,
    });
    return ctx([...role.permissions], [role.code]);
  }

  it('refuses to create a role ranked at or above the creator', async () => {
    const manager = await rankedRoleManager(70);

    await expect(
      roleService.createCustomRole(manager, {
        code: 'peer-role',
        name: 'Peer',
        permissions: [PERMISSIONS.RESIDENT_VIEW],
        rank: 70,
      }),
    ).rejects.toThrow(/at or above your own/);

    await expect(
      roleService.createCustomRole(manager, {
        code: 'superior-role',
        name: 'Superior',
        permissions: [PERMISSIONS.RESIDENT_VIEW],
        rank: 95,
      }),
    ).rejects.toThrow(/at or above your own/);
  });

  it('refuses to grant a permission the creator does not hold', async () => {
    const manager = await rankedRoleManager(60);

    // This actor cannot refund; it must not be able to create a role that can.
    await expect(
      roleService.createCustomRole(manager, {
        code: 'refunder',
        name: 'Refunder',
        permissions: [PERMISSIONS.PAYMENT_REFUND],
        rank: 30,
      }),
    ).rejects.toThrow(/cannot grant permissions you do not hold/);
  });

  it('rejects unregistered permission strings', async () => {
    await expect(
      roleService.createCustomRole(chairman(), {
        code: 'invented',
        name: 'Invented',
        permissions: ['resident.doAnything'],
        rank: 20,
      }),
    ).rejects.toThrow(/Unknown permissions/);
  });

  it('requires role.create', async () => {
    await expect(
      roleService.createCustomRole(ctx([PERMISSIONS.RESIDENT_VIEW]), {
        code: 'x',
        name: 'X',
        permissions: [],
        rank: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows a legitimate custom role', async () => {
    const role = await roleService.createCustomRole(chairman(), {
      code: 'gate-supervisor',
      name: 'Gate Supervisor',
      permissions: [PERMISSIONS.GATE_LOG_VIEW, PERMISSIONS.VISITOR_APPROVE],
      rank: 50,
    });

    expect(role.isSystem).toBe(false);
    expect(role.permissions).toEqual([PERMISSIONS.GATE_LOG_VIEW, PERMISSIONS.VISITOR_APPROVE]);
  });

  it('rejects a duplicate role code within an estate', async () => {
    await roleService.createCustomRole(chairman(), {
      code: 'gate-supervisor',
      name: 'Gate Supervisor',
      permissions: [PERMISSIONS.GATE_LOG_VIEW],
      rank: 50,
    });

    await expect(
      roleService.createCustomRole(chairman(), {
        code: 'gate-supervisor',
        name: 'Duplicate',
        permissions: [],
        rank: 40,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('system role protection', () => {
  beforeEach(async () => {
    await roleService.seedSystemRoles(ESTATE_A);
  });

  // A chairman who stripped gate.operate from the officer role would lock their
  // own gates, and it would present as a hardware fault.
  it('refuses to modify a system role', async () => {
    const officer = await roleRepository.findByCode(chairman(), 'security-officer');

    await expect(
      roleService.updateRole(chairman(), officer!._id.toHexString(), { permissions: [] }),
    ).rejects.toThrow(/System roles cannot be modified/);
  });

  it('refuses to delete a system role', async () => {
    const officer = await roleRepository.findByCode(chairman(), 'security-officer');

    await expect(roleService.deleteRole(chairman(), officer!._id.toHexString())).rejects.toThrow(
      /System roles cannot be deleted/,
    );
  });

  it('allows editing and deleting a custom role', async () => {
    const role = await roleService.createCustomRole(chairman(), {
      code: 'temp-role',
      name: 'Temp',
      permissions: [PERMISSIONS.GATE_LOG_VIEW],
      rank: 30,
    });

    const updated = await roleService.updateRole(chairman(), role._id.toHexString(), {
      name: 'Renamed',
    });
    expect(updated.name).toBe('Renamed');

    await roleService.deleteRole(chairman(), role._id.toHexString());
    expect(await roleRepository.findById(chairman(), role._id)).toBeNull();
  });
});

describe('tenant isolation', () => {
  it('cannot read or modify another estate roles', async () => {
    await roleService.seedSystemRoles(ESTATE_A);
    const roleInA = await RoleModel.findOne({ estateId: ESTATE_A, code: 'resident' }).lean();

    const foreignChairman = ctx(
      [...(getSystemRole('estate-chairman')!.permissions as string[])],
      ['estate-chairman'],
      ESTATE_B,
    );

    expect(await roleRepository.findById(foreignChairman, roleInA!._id)).toBeNull();
    await expect(
      roleService.updateRole(foreignChairman, roleInA!._id.toHexString(), { name: 'Hijacked' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('audit trail', () => {
  beforeEach(async () => {
    await roleService.seedSystemRoles(ESTATE_A);
  });

  it('records role creation, update and deletion', async () => {
    const actor = chairman();

    const role = await roleService.createCustomRole(actor, {
      code: 'audited-role',
      name: 'Audited',
      permissions: [PERMISSIONS.GATE_LOG_VIEW],
      rank: 30,
    });
    await roleService.updateRole(actor, role._id.toHexString(), { name: 'Renamed' });
    await roleService.deleteRole(actor, role._id.toHexString());

    const entries = await AuditLogModel.find({ resource: 'role' }).sort({ createdAt: 1 }).lean();
    expect(entries.map((e) => e.action)).toEqual(['role.created', 'role.updated', 'role.deleted']);
  });

  // The audit entry and the change must commit or roll back together.
  it('writes the entry inside the same transaction as the change', async () => {
    const actor = chairman();
    await roleService.createCustomRole(actor, {
      code: 'tx-role',
      name: 'Tx',
      permissions: [PERMISSIONS.GATE_LOG_VIEW],
      rank: 30,
    });

    const entry = await AuditLogModel.findOne({ action: 'role.created' }).lean();
    expect(entry?.estateId?.toHexString()).toBe(ESTATE_A);
    expect(entry?.actorRoles).toEqual(['estate-chairman']);
  });
});

/**
 * Assigning roles.
 *
 * Nothing did this before — roles could be defined, and the seeder wrote them
 * directly, but no administrator could make somebody a security officer. Since
 * this is how a person gains permissions, it is the escalation surface, and the
 * tests are mostly about who is refused.
 */
describe('assigning roles to a membership', () => {
  async function seededEstate() {
    const roles = await roleService.seedSystemRoles(ESTATE_A);
    const byCode = new Map(roles.map((role) => [role.code, role]));

    const user = await UserModel.create({
      firstName: 'Ada',
      lastName: 'Okonkwo',
      email: `ada-${Math.random().toString(36).slice(2, 8)}@example.com`,
      phone: `+23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      emailIndex: blindIndex(`ada-${Math.random()}@example.com`, 'email'),
      phoneIndex: blindIndex(`+23480${Math.random()}`, 'phone'),
      passwordHash: 'x',
      status: 'active',
    });

    const membership = await MembershipModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      userId: user._id,
      category: 'homeowner',
      status: 'active',
      roleIds: [],
    });

    return { byCode, membership, user };
  }

  it('sets the roles a membership holds', async () => {
    const { byCode, membership } = await seededEstate();
    const officer = byCode.get('security-officer')!;

    const updated = await roleService.assignRoles(chairman(), membership._id.toHexString(), [
      officer._id.toHexString(),
    ]);

    expect(updated.roleIds.map((id) => id.toHexString())).toEqual([officer._id.toHexString()]);
  });

  it('replaces the whole set rather than adding to it', async () => {
    const { byCode, membership } = await seededEstate();
    const officer = byCode.get('security-officer')!;
    const resident = byCode.get('resident')!;

    await roleService.assignRoles(chairman(), membership._id.toHexString(), [
      officer._id.toHexString(),
    ]);
    const updated = await roleService.assignRoles(chairman(), membership._id.toHexString(), [
      resident._id.toHexString(),
    ]);

    expect(updated.roleIds.map((id) => id.toHexString())).toEqual([resident._id.toHexString()]);
  });

  it('requires role.assign', async () => {
    const { byCode, membership } = await seededEstate();

    await expect(
      roleService.assignRoles(ctx([PERMISSIONS.ROLE_VIEW]), membership._id.toHexString(), [
        byCode.get('resident')!._id.toHexString(),
      ]),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  /**
   * Without this the rank ceiling is decorative: a manager does not need to
   * create a role above their own when they can simply take one that exists.
   */
  it('refuses to let anyone change their own roles', async () => {
    const { byCode, membership, user } = await seededEstate();

    const self = {
      ...chairman(),
      userId: user._id.toHexString(),
    };

    await expect(
      roleService.assignRoles(self, membership._id.toHexString(), [
        byCode.get('estate-chairman')!._id.toHexString(),
      ]),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a role ranked at or above the assigner', async () => {
    const { byCode, membership } = await seededEstate();
    const manager = byCode.get('estate-manager')!;

    // A manager assigning the chairman role: granting a role they could not
    // have defined is the same escalation by a shorter path.
    const asManager = ctx(
      [...(manager.permissions as string[]), PERMISSIONS.ROLE_ASSIGN],
      ['estate-manager'],
    );

    await expect(
      roleService.assignRoles(asManager, membership._id.toHexString(), [
        byCode.get('estate-chairman')!._id.toHexString(),
      ]),
    ).rejects.toThrow(/ranked at or above/);
  });

  /**
   * The superset rule is for custom roles.
   *
   * A system role is defined by the platform and frozen against edits, so
   * assigning one cannot smuggle a permission anywhere; the rank ceiling is
   * the control. Applying the rule there would mean a chairman could not
   * appoint a security officer without personally holding `gate.operate` —
   * appointing somebody is not the same as becoming them.
   */
  it('lets a chairman appoint an officer without holding gate permissions', async () => {
    const { byCode, membership } = await seededEstate();

    expect(chairman().permissions.has(PERMISSIONS.GATE_OPERATE)).toBe(false);

    await expect(
      roleService.assignRoles(chairman(), membership._id.toHexString(), [
        byCode.get('security-officer')!._id.toHexString(),
      ]),
    ).resolves.toBeDefined();
  });

  it('refuses a custom role granting permissions the assigner does not hold', async () => {
    const { membership } = await seededEstate();

    const custom = await roleService.createCustomRole(chairman(), {
      code: 'auditor',
      name: 'Auditor',
      description: 'Reads the audit trail.',
      rank: 40,
      permissions: [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.LEDGER_VIEW],
    });

    const narrow = ctx([PERMISSIONS.ROLE_ASSIGN], ['estate-chairman']);

    await expect(
      roleService.assignRoles(narrow, membership._id.toHexString(), [
        custom._id.toHexString(),
      ]),
    ).rejects.toThrow(/permissions you do not hold/);
  });

  it('refuses a membership in another estate', async () => {
    const { byCode } = await seededEstate();

    const elsewhere = await MembershipModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_B),
      userId: new mongoose.Types.ObjectId(),
      category: 'homeowner',
      status: 'active',
      roleIds: [],
    });

    await expect(
      roleService.assignRoles(chairman(), elsewhere._id.toHexString(), [
        byCode.get('resident')!._id.toHexString(),
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * Access tokens carry permissions and last fifteen minutes, so a demotion
   * that leaves existing sessions alone takes effect a quarter of an hour late.
   */
  it('revokes the person’s sessions, so a demotion is immediate', async () => {
    const { byCode, membership, user } = await seededEstate();

    await SessionModel.create({
      userId: user._id,
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      refreshTokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await roleService.assignRoles(chairman(), membership._id.toHexString(), [
      byCode.get('resident')!._id.toHexString(),
    ]);

    const live = await SessionModel.countDocuments({ userId: user._id, revokedAt: null });
    expect(live).toBe(0);
  });

  it('records who changed what', async () => {
    const { byCode, membership } = await seededEstate();

    await roleService.assignRoles(chairman(), membership._id.toHexString(), [
      byCode.get('security-officer')!._id.toHexString(),
    ]);

    const entry = await AuditLogModel.findOne({ action: 'role.assigned' }).lean();
    expect(entry).toBeTruthy();
    expect(entry?.metadata?.granted).toBe('security-officer');
  });
});
