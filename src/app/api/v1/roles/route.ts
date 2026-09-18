import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { ALL_PERMISSIONS, PERMISSIONS, groupPermissions } from '@/core/rbac';
import { roleRepository, roleService } from '@/modules/role';

export const GET = defineRoute({
  permissions: [PERMISSIONS.ROLE_VIEW],
  handler: async (ctx) => {
    const roles = await roleRepository.findMany(ctx, {}, { sort: { rank: -1 } });

    return {
      roles: roles.map((role) => ({
        id: role._id.toHexString(),
        code: role.code,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        isSystem: role.isSystem,
        rank: role.rank,
      })),
      // Supplied alongside so the role editor can render the full matrix
      // without a second round trip.
      availablePermissions: groupPermissions(),
    };
  },
});

const CreateRoleDto = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9-]{1,40}$/, 'Use lowercase letters, numbers and hyphens.'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(200),
  rank: z.number().int().min(0).max(99),
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.ROLE_CREATE],
  body: CreateRoleDto,
  // Creating roles is how privilege escalation is attempted, so the ceiling is
  // low and every attempt lands in the audit trail.
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'roles:create' },
  handler: async (ctx, { body }) => {
    const role = await roleService.createCustomRole(ctx, body);
    return { id: role._id.toHexString(), code: role.code, name: role.name };
  },
});
