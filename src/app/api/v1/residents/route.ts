import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { residentService } from '@/modules/resident';

const ListDto = z.object({
  category: z
    .enum([
      'homeowner',
      'landlord',
      'tenant',
      'dependant',
      'family-member',
      'domestic-staff',
      'estate-staff',
      'security-personnel',
      'contractor',
      'other',
    ])
    .optional(),
  status: z.enum(['pending', 'awaiting-approval', 'active', 'suspended', 'exited']).optional(),
  propertyId: z.string().optional(),
  search: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const GET = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_VIEW],
  query: ListDto,
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    return paginated(await residentService.list(ctx, filters, { page, limit }));
  },
});
