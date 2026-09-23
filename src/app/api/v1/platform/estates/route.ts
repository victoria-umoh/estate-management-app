import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { platformService } from '@/modules/platform';

export const GET = defineRoute({
  permissions: [PERMISSIONS.PLATFORM_ESTATE_VIEW],
  query: z.object({
    status: z.enum(['trial', 'active', 'past-due', 'suspended', 'closed']).optional(),
    search: z.string().trim().max(60).optional(),
  }),
  handler: async (ctx, { query }) => platformService.listEstates(ctx, query),
});
