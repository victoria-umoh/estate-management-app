import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { roleService } from '@/modules/role';

/**
 * Amend a custom role.
 *
 * System roles are refused by the service, not here — the rule belongs next to
 * the data, and a second copy of it in the route is a second copy to forget.
 */
export const PATCH = defineRoute({
  permissions: [PERMISSIONS.ROLE_UPDATE],
  params: z.object({ id: z.string() }),
  body: z.object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(200).optional(),
    permissions: z.array(z.string()).max(200).optional(),
  }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const role = await roleService.updateRole(ctx, params.id, body);

    return {
      id: role._id.toHexString(),
      code: role.code,
      name: role.name,
      description: role.description ?? null,
      permissions: role.permissions,
      isSystem: role.isSystem,
      rank: role.rank,
    };
  },
});

export const DELETE = defineRoute({
  permissions: [PERMISSIONS.ROLE_DELETE],
  params: z.object({ id: z.string() }),
  status: 200,
  handler: async (ctx, { params }) => {
    await roleService.deleteRole(ctx, params.id);
    return { deleted: true };
  },
});
