import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { roleService } from '@/modules/role';

/**
 * Set which roles a resident holds.
 *
 * The whole set is sent, not a delta. A delta invites two administrators
 * editing at once to each apply half a change and leave a set neither intended.
 */
export const PUT = defineRoute({
  permissions: [PERMISSIONS.ROLE_ASSIGN],
  params: z.object({ id: z.string() }),
  body: z.object({ roleIds: z.array(z.string()).max(10) }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const membership = await roleService.assignRoles(ctx, params.id, body.roleIds);

    return {
      membershipId: membership._id.toHexString(),
      roleIds: membership.roleIds.map((id) => id.toHexString()),
    };
  },
});
