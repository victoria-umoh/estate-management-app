import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { residentService } from '@/modules/resident';

export const GET = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_VIEW],
  params: z.object({ id: z.string() }),
  handler: async (ctx, { params }) => residentService.detail(ctx, params.id),
});
