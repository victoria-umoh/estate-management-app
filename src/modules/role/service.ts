import type { ClientSession, Types } from 'mongoose';
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
import { membershipRepository } from '@/modules/membership/repository';
import type { MembershipDoc } from '@/modules/membership/schema';
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
  async seedSystemRoles(
    estateId: string,
    options: { session?: ClientSession } = {},
  ): Promise<RoleDoc[]> {
    const context = systemContext(estateId);
    const created: RoleDoc[] = [];
    // Passed straight through so a caller creating an estate can seed its roles
    // inside the same transaction. An estate whose roles committed while the
    // estate itself rolled back — or the reverse — has no chairman and no way
    // to appoint one.
    const session = options.session ? { session: options.session } : {};

    for (const definition of SYSTEM_ROLES) {
      const existing = await roleRepository.findByCode(context, definition.code, session);
      if (existing) {
        created.push(existing);
        continue;
      }

      created.push(
        await roleRepository.create(
          context,
          {
            code: definition.code,
            name: definition.name,
            description: definition.description,
            permissions: [...definition.permissions],
            isSystem: true,
            rank: definition.rank,
          },
          session,
        ),
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

    // The same rank rule `createCustomRole` applies, which this was missing.
    // Not exploitable with the roles as shipped — only the chairman holds
    // `role.update`, and nothing outranks a chairman — but it becomes
    // exploitable the moment an estate mints a custom role carrying it, and
    // then a manager can edit a role above their own and assign it to
    // themselves. The rule belongs on both paths or on neither.
    const actorRank = await this.actorHighestRank(context);

    if (!canGrantRank(actorRank, role.rank)) {
      throw new AuthorizationError('You cannot modify a role ranked at or above your own.');
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

  /**
   * Set which roles a membership holds.
   *
   * Nothing assigned roles before this: they could be defined, and the seeder
   * wrote them directly, but no administrator could make somebody a security
   * officer. `role.assign` was declared and gated nothing.
   *
   * It is the privilege-escalation surface, so it carries every rule
   * `createCustomRole` has and one more that neither create nor update needs:
   * **you cannot change your own roles.** Without that, an estate manager
   * grants themselves the chairman role and the rank ceiling is decorative —
   * they are not creating a role above their own, merely taking one that
   * already exists.
   */
  async assignRoles(
    context: RequestContext,
    membershipId: string,
    roleIds: string[],
  ): Promise<MembershipDoc> {
    assertCan(context, PERMISSIONS.ROLE_ASSIGN);

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);

    if (membership.userId.toHexString() === context.userId) {
      throw new AuthorizationError(
        'You cannot change your own roles. Ask another administrator.',
      );
    }

    // De-duplicated, so the same role sent twice is stored once. The
    // repository call is estate-scoped, so a role from another estate is a 404
    // rather than something to check for here.
    const roles = await Promise.all(
      [...new Set(roleIds)].map((id) => roleRepository.findByIdOrFail(context, id)),
    );

    const actorRank = await this.actorHighestRank(context);

    for (const role of roles) {
      // The same ceiling as creating one. Granting a role you could not have
      // defined is the same escalation by a shorter path.
      if (!canGrantRank(actorRank, role.rank)) {
        throw new AuthorizationError(
          `You cannot assign "${role.name}", which is ranked at or above your own.`,
        );
      }

      /**
       * The superset rule applies to custom roles only.
       *
       * When you *create* a role, refusing permissions you do not hold is
       * right: you would otherwise mint powers you lack and take them. A
       * system role is different — it is defined by the platform, frozen
       * against edits, and cannot have anything smuggled into it. Applying the
       * rule there says a chairman may not appoint a security officer unless
       * the chairman personally holds `gate.operate`, which would force every
       * chairman to hold every permission in the estate in order to delegate
       * any of it. Appointing somebody is not the same as becoming them.
       *
       * The rank ceiling above still applies to both.
       */
      if (!role.isSystem) {
        const beyond = role.permissions.filter((p) => !context.permissions.has(p));
        if (beyond.length > 0 && !context.permissions.has(WILDCARD)) {
          throw new AuthorizationError(
            `"${role.name}" grants permissions you do not hold: ${beyond.join(', ')}.`,
          );
        }
      }
    }

    const before = membership.roleIds.map((id) => id.toHexString());

    const updated = await membershipRepository.updateById(context, membershipId, {
      $set: { roleIds: roles.map((role) => role._id) },
    });

    // Their next request must reflect this. Access tokens carry permissions and
    // last fifteen minutes, so a demotion that leaves existing sessions alone
    // is a demotion that takes effect a quarter of an hour late — which is the
    // wrong direction to be lenient in.
    const { sessionRepository } = await import('@/modules/auth');
    await sessionRepository.revokeAllForUser(membership.userId, 'admin-revoked');

    await auditService.record(context, {
      action: 'role.assigned',
      resource: 'membership',
      resourceId: membershipId,
      // In metadata, not a before/after diff: the differ summarises arrays as
      // "[N items]", which answers nothing about which roles were granted —
      // the only question anyone asks of this entry afterwards.
      // Joined, not an array: the audit layer summarises arrays as "[N items]"
      // in metadata as well as in diffs, and "[1 items]" answers nothing about
      // which role somebody was given.
      metadata: {
        granted: roles.map((role) => role.code).join(', ') || 'none',
        previousRoleCount: before.length,
      },
    });

    return updated;
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
