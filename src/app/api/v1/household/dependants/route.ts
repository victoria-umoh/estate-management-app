import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { householdService } from '@/modules/household';

const RELATIONSHIPS = [
  'child',
  'spouse',
  'parent',
  'sibling',
  'ward',
  'domestic-staff',
  'driver',
  'other',
] as const;

export const GET = defineRoute({
  permissions: [PERMISSIONS.HOUSEHOLD_VIEW],
  query: z.object({ guardianMembershipId: z.string() }),
  handler: async (ctx, { query }) => {
    const dependants = await householdService.listForGuardian(ctx, query.guardianMembershipId);

    return dependants.map((dependant) => ({
      id: dependant._id.toHexString(),
      firstName: dependant.firstName,
      lastName: dependant.lastName,
      relationship: dependant.relationship,
      dateOfBirth: dependant.dateOfBirth,
      photoUrl: dependant.photoUrl,
      // Masked, as everywhere outside the dedicated reveal endpoint.
      ninMasked: dependant.ninLast4 ? `${'•'.repeat(7)}${dependant.ninLast4}` : null,
      schoolOrWorkplace: dependant.schoolOrWorkplace,
    }));
  },
});

const AddDependantDto = z.object({
  guardianMembershipId: z.string().min(1),
  firstName: z.string().trim().min(2).max(80),
  middleName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().min(2).max(80),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.enum(['male', 'female', 'other', 'undisclosed']).optional(),
  relationship: z.enum(RELATIONSHIPS),
  phone: z.string().trim().max(20).optional(),
  nin: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .refine((value) => value.length === 11, 'A NIN is 11 digits.')
    .optional(),
  schoolOrWorkplace: z.string().trim().max(200).optional(),
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.HOUSEHOLD_CREATE],
  body: AddDependantDto,
  handler: async (ctx, { body }) => {
    const dependant = await householdService.addDependant(ctx, body);
    return { id: dependant._id.toHexString(), firstName: dependant.firstName };
  },
});
