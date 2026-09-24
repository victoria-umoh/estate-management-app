import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { platformService } from '@/modules/platform';

const EstateFilters = z.object({
  status: z.enum(['trial', 'active', 'past-due', 'suspended', 'closed']).optional(),
  search: z.string().trim().max(60).optional(),
});

export const GET = defineRoute({
  permissions: [PERMISSIONS.PLATFORM_ESTATE_VIEW],
  query: EstateFilters,
  handler: async (ctx, { query }) => platformService.listEstates(ctx, query),
});

/**
 * Provision an estate for a customer who arrived through sales.
 *
 * `platform.estate.create` is declared here AND asserted in the service, which
 * also demands `isPlatformAdmin`. The permission previously existed and gated
 * nothing — a role that appears to confer estate creation and does not is worse
 * than no permission at all, because a permission audit passes for the wrong
 * reason.
 *
 * No credentials are set here. The chairman is invited afterwards and chooses
 * their own password, so no operator ever knows a customer's.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.PLATFORM_ESTATE_CREATE],
  body: z.object({
    name: z.string().trim().min(3).max(120),
    address: z.object({
      line1: z.string().trim().min(3).max(200),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().min(2).max(80),
      state: z.string().trim().min(2).max(80),
      country: z.string().trim().min(2).max(80).default('Nigeria'),
      postalCode: z.string().trim().max(20).optional(),
    }),
    contact: z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      phone: z.string().trim().min(7).max(20),
      website: z.string().trim().url().max(200).optional(),
    }),
  }),
  handler: async (ctx, { body }) => platformService.createEstate(ctx, body),
});
