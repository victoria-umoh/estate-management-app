import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';
import { temporaryPassService } from '@/modules/temporary-pass';

export const GET = defineRoute({
  permissions: [PERMISSIONS.TEMPORARY_PASS_VERIFY],
  query: z.object({
    status: z.enum(['active', 'expired', 'revoked']).optional(),
    sponsorMembershipId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await temporaryPassService.list(ctx, filters, { page, limit });

    return paginated({
      ...result,
      items: result.items.map((pass) => ({
        id: pass._id.toHexString(),
        code: pass.code,
        holderName: pass.holderName,
        company: pass.company ?? null,
        purpose: pass.purpose,
        status: pass.status,
        validFrom: pass.validFrom,
        validUntil: pass.validUntil,
        // A reusable pass is judged on how it is being used, not on whether it
        // has been used, so both travel with the list.
        useCount: pass.useCount,
        inside: pass.inside,
        lastUsedAt: pass.lastUsedAt ?? null,
      })),
    });
  },
});

/**
 * Issue a temporary pass.
 *
 * The sponsor is the caller, resolved from the session. A route that accepted a
 * membership id would let anyone attach a contractor to another household.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.TEMPORARY_PASS_CREATE],
  body: z.object({
    holderName: z.string().trim().min(2).max(120),
    holderPhone: z.string().trim().max(20).optional(),
    company: z.string().trim().max(120).optional(),
    purpose: z.string().trim().min(2).max(200),
    vehiclePlate: z.string().trim().max(20).optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date(),
    notes: z.string().trim().max(1000).optional(),
  }),
  rateLimit: { key: 'user', limit: 30, window: '1h', bucket: 'temporary-pass:create' },
  handler: async (ctx, { body }) => {
    const sponsorMembershipId = await meService.membershipId(ctx);
    const { pass, token } = await temporaryPassService.issue(ctx, {
      ...body,
      sponsorMembershipId,
    });

    return {
      id: pass._id.toHexString(),
      code: pass.code,
      holderName: pass.holderName,
      status: pass.status,
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      token,
    };
  },
});
