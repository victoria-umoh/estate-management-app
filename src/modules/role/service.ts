import type { Types } from 'mongoose';
import { withTransaction } from '@/core/db';
import { AuthorizationError, ConflictError, UnprocessableError } from '@/core/errors';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  assertCan,
  canGrantRank,
  isKnownPermission,
  WILDCARD,
} from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { roleRepository } from './repository';
import type { RoleDoc } from './schema';

/**
 * Role management.
 *
 * The rules here exist to stop privilege escalation, which is the main way a
 * role system fails: an administrator who can define roles can otherwise simply
 * define one with every permission and assign it to themselves.
 */
export class RoleService {
  /**
   * Seed the system roles into a new estate.
   *
   * Each estate gets its own copies so a chairman can inspect exactly what
   * their officers can do, and so a future per-estate tweak does not require a
   * schema change. Idempotent, so re-running setup is safe.
   */
  async seedSystemRoles(estateId: string): Promise<RoleDoc[]> {
    const context = systemContext(estateId);
    const created: RoleDoc[] = [];

    for (const definition of SYSTEM_ROLES) {
      const existing = await roleRepository.findByCode(context, definition.code);
      if (existing) {
        created.push(existing);
        continue;
      }

      created.push(
        await roleRepository.create(context, {
          code: definition.code,
          name: definition.name,
          description: definition.description,
          permissions: [...definition.permissions],
          isSystem: true,
          rank: definition.rank,
        }),
      );
    }

    return created;
  }

  /**
   * Resolve a membership's effective permissions.
   *
   * The union of every assigned role. Returning the wildcard alone when present
   * keeps super-admin tokens small and means a permission added later is
   * covered without reissuing anything.
   */
  async resolvePermissions(
    estateId: Types.ObjectId,
    roleIds: Types.ObjectId[],
  ): Promise<{ roles: string[]; permissions: string[]; highestRank: number }> {
    const roles = await roleRepository.resolveForLogin(estateId, roleIds);

    const permissions = new Set<string>();
    let highestRank = 0;

    for (const role of roles) {
      for (const permission of role.permissions) permissions.add(permission);
      highestRank = Math.max(highestRank, role.rank);
    }

    if (permissions.has(WILDCARD)) {
      return { roles: roles.map((r) => r.code), permissions: [WILDCARD], highestRank };
    }

    return {
      roles: roles.map((role) => role.code),
      permissions: [...permissions],
      highestRank,
    };
  }

  async createCustomRole(
    context: RequestContext,
    input: {
      code: string;
      name: string;
      description?: string;
      permissions: string[];
      rank: number;
    },
  ): Promise<RoleDoc> {
    assertCan(context, PERMISSIONS.ROLE_CREATE);

    // Checked before the unknown-permission check: '*' is not in the registry,
    // so it would otherwise be reported as a typo rather than as the escalation
    // attempt it is. The wildcard is reserved for the platform super-admin —
    // without this, any role creator could mint unlimited authority in one step.
    if (input.permissions.includes(WILDCARD)) {
      throw new AuthorizationError('The wildcard permission cannot be assigned to a custom role.');
    }

    const unknown = input.permissions.filter((p) => !isKnownPermission(p));
    if (unknown.length > 0) {
      throw new UnprocessableError(`Unknown permissions: ${unknown.join(', ')}.`);
    }

    const actorRank = await this.actorHighestRank(context);

    // A role cannot outrank its creator, or a manager would define a
    // chairman-equivalent role and assign it to themselves.
    if (!canGrantRank(actorRank, input.rank)) {
      throw new AuthorizationError('You cannot create a role ranked at or above your own.');
    }

    // Nor can it grant a permission the creator does not hold.
    const beyond = input.permissions.filter((p) => !context.permissions.has(p));
    if (beyond.length > 0 && !context.permissions.has(WILDCARD)) {
      throw new AuthorizationError(
        `You cannot grant permissions you do not hold: ${beyond.join(', ')}.`,
      );
    }

    if (await roleRepository.findByCode(context, input.code)) {
      throw new ConflictError(`A role with the code "${input.code}" already exists.`);
    }

    return withTransaction(async (session) => {
      const role = await roleRepository.create(
        context,
        {
          code: input.code.toLowerCase(),
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          permissions: input.permissions,
          isSystem: false,
          rank: input.rank,
        },
        { session },
      );

      await auditService.record(context, {
        action: 'role.created',
        resource: 'role',
        resourceId: role._id,
        after: { code: role.code, permissions: role.permissions, rank: role.rank },
        session,
      });

      return role;
    });
  }

  async updateRole(
    context: RequestContext,
    roleId: string,
    updates: { name?: string; description?: string; permissions?: string[] },
  ): Promise<RoleDoc> {
    assertCan(context, PERMISSIONS.ROLE_UPDATE);

    const role = await roleRepository.findByIdOrFail(context, roleId);

    // System roles are frozen: a chairman who stripped `gate.operate` from the
    // officer role would lock their own gates, and it would present as a
    // hardware fault rather than a permission change.
    if (role.isSystem) {
      throw new AuthorizationError('System roles cannot be modified.');
    }

    if (updates.permissions) {
      if (updates.permissions.includes(WILDCARD)) {
        throw new AuthorizationError(
          'The wildcard permission cannot be assigned to a custom role.',
        );
      }

      const unknown = updates.permissions.filter((p) => !isKnownPermission(p));
      if (unknown.length > 0) {
        throw new UnprocessableError(`Unknown permissions: ${unknown.join(', ')}.`);
      }

      const beyond = updates.permissions.filter((p) => !context.permissions.has(p));
      if (beyond.length > 0 && !context.permissions.has(WILDCARD)) {
        throw new AuthorizationError(
          `You cannot grant permissions you do not hold: ${beyond.join(', ')}.`,
        );
      }
    }

    return withTransaction(async (session) => {
      const updated = await roleRepository.updateById(
        context,
        roleId,
        { $set: updates },
        { session },
      );

      await auditService.record(context, {
        action: 'role.updated',
        resource: 'role',
        resourceId: roleId,
        before: { name: role.name, permissions: role.permissions },
        after: { name: updated.name, permissions: updated.permissions },
        session,
      });

      return updated;
    });
  }

  async deleteRole(context: RequestContext, roleId: string): Promise<void> {
    assertCan(context, PERMISSIONS.ROLE_DELETE);

    const role = await roleRepository.findByIdOrFail(context, roleId);
    if (role.isSystem) throw new AuthorizationError('System roles cannot be deleted.');

    await withTransaction(async (session) => {
      await roleRepository.softDelete(context, roleId, { session });
      await auditService.record(context, {
        action: 'role.deleted',
        resource: 'role',
        resourceId: roleId,
        before: { code: role.code, permissions: role.permissions },
        session,
      });
    });
  }

  /** The highest rank the acting user holds, used for escalation checks. */
  private async actorHighestRank(context: RequestContext): Promise<number> {
    if (context.permissions.has(WILDCARD)) return 100;

    const roles = await roleRepository.findMany(context, { code: { $in: [...context.roles] } });
    return roles.reduce((highest, role) => Math.max(highest, role.rank), 0);
  }
}

export const roleService = new RoleService();
