import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';

export const DELETE = defineRoute({
  permissions: [PERMISSIONS.HOUSEHOLD_DELETE],
  params: z.object({ id: z.string() }),
  status: 200,
  handler: async (ctx, { params }) => {
    await meService.removeDependant(ctx, params.id);
    return { removed: true };
  },
});
