import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { exitPassService } from '@/modules/exit-pass';
import { meService } from '@/modules/me';

const ItemDto = z.object({
  quantity: z.number().int().min(1).max(10_000),
  description: z.string().trim().min(2).max(200),
  identifyingMark: z.string().trim().max(120).optional(),
  /**
   * Integer minor units (kobo), as everywhere else money appears here.
   *
   * It was a bare `number` with no stated unit, which left each caller to guess
   * — and a manifest that values a television at 250 when the reader expects
   * 25000 is worse than one that omits the value.
   */
  estimatedValue: z.number().int().min(0).optional(),
});

/**
 * List exit passes.
 *
 * Residents hold `exitPass.view` for their own removals, so the caller's
 * membership is resolved from the session and handed to the service, which
 * narrows the query for anyone who cannot approve. The membership id is never
 * read from the request — a route that accepts one is a route where changing a
 * value in dev tools reads another household's removals.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.EXIT_PASS_VIEW],
  query: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'used', 'expired', 'cancelled']).optional(),
    requestedByMembershipId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const callerMembershipId = await meService.membershipId(ctx);

    const result = await exitPassService.list(ctx, filters, callerMembershipId, { page, limit });

    return paginated({
      ...result,
      items: result.items.map((pass) => ({
        id: pass._id.toHexString(),
        code: pass.code,
        carrierName: pass.carrierName,
        destination: pass.destination,
        reason: pass.reason,
        itemCount: pass.items.length,
        totalQuantity: pass.items.reduce((sum, item) => sum + item.quantity, 0),
        status: pass.status,
        approvalRequired: pass.approvalRequired,
        validFrom: pass.validFrom,
        validUntil: pass.validUntil,
        usedAt: pass.usedAt ?? null,
        createdAt: pass.createdAt,
      })),
    });
  },
});

/**
 * Declare goods for removal.
 *
 * The one-time token is returned here and nowhere else, and only when the pass
 * is immediately valid — an estate that requires approval gets `token: null`
 * until an approver acts.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.EXIT_PASS_CREATE],
  body: z.object({
    carrierName: z.string().trim().min(2).max(120),
    carrierPhone: z.string().trim().max(20).optional(),
    destination: z.string().trim().min(2).max(200),
    reason: z.string().trim().min(2).max(200),
    vehiclePlate: z.string().trim().max(20).optional(),
    items: z.array(ItemDto).min(1).max(100),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
  rateLimit: { key: 'user', limit: 30, window: '1h', bucket: 'exit-pass:create' },
  handler: async (ctx, { body }) => {
    const requestedByMembershipId = await meService.membershipId(ctx);
    const { pass, token } = await exitPassService.create(ctx, {
      ...body,
      requestedByMembershipId,
    });

    return {
      id: pass._id.toHexString(),
      code: pass.code,
      status: pass.status,
      approvalRequired: pass.approvalRequired,
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      items: pass.items,
      token,
    };
  },
});
