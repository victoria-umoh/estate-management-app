import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';

export const GET = defineRoute({
  permissions: [PERMISSIONS.HOUSEHOLD_VIEW],
  handler: async (ctx) => {
    const dependants = await meService.household(ctx);

    return dependants.map((dependant) => ({
      id: dependant._id.toHexString(),
      firstName: dependant.firstName,
      middleName: dependant.middleName ?? null,
      lastName: dependant.lastName,
      relationship: dependant.relationship,
      dateOfBirth: dependant.dateOfBirth ?? null,
      gender: dependant.gender ?? null,
      phone: dependant.phone ?? null,
      schoolOrWorkplace: dependant.schoolOrWorkplace ?? null,
    }));
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.HOUSEHOLD_CREATE],
  body: z.object({
    firstName: z.string().trim().min(1).max(80),
    middleName: z.string().trim().max(80).optional(),
    lastName: z.string().trim().min(1).max(80),
    dateOfBirth: z.coerce.date().optional(),
    gender: z.enum(['male', 'female', 'other', 'undisclosed']).optional(),
    relationship: z.enum([
      'child',
      'spouse',
      'parent',
      'sibling',
      'ward',
      'domestic-staff',
      'driver',
      'other',
    ]),
    phone: z.string().trim().max(20).optional(),
    schoolOrWorkplace: z.string().trim().max(120).optional(),
  }),
  handler: async (ctx, { body }) => {
    const dependant = await meService.addDependant(ctx, body);

    return { id: dependant._id.toHexString(), firstName: dependant.firstName };
  },
});
