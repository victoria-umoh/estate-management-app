import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';
import { visitorService } from '@/modules/visitor';

export const GET = defineRoute({
  permissions: [PERMISSIONS.VISITOR_VIEW],
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const result = await meService.visitorPasses(ctx, query);

    return paginated({
      ...result,
      items: result.items.map((pass) => ({
        id: pass._id.toHexString(),
        code: pass.code,
        passType: pass.passType,
        visitorName: pass.visitorName,
        visitorPhone: pass.visitorPhone ?? null,
        partySize: pass.partySize,
        purpose: pass.purpose,
        vehiclePlate: pass.vehiclePlate ?? null,
        expectedArrival: pass.expectedArrival,
        expectedDeparture: pass.expectedDeparture,
        status: pass.status,
        checkedInAt: pass.checkedInAt ?? null,
        checkedOutAt: pass.checkedOutAt ?? null,
      })),
    });
  },
});

/**
 * Create a visitor pass.
 *
 * The host is the caller — it is never taken from the request, so a resident
 * cannot issue a pass against another household's address.
 *
 * The one-time token is returned here and nowhere else. It is what the QR
 * encodes, and it is not stored in a form the server can hand back later, so a
 * client that discards it must issue a new pass rather than re-read this one.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.VISITOR_CREATE],
  body: z.object({
    visitorName: z.string().trim().min(2).max(120),
    visitorPhone: z.string().trim().max(20).optional(),
    partySize: z.number().int().min(1).max(50).optional(),
    purpose: z.string().trim().min(2).max(200),
    vehiclePlate: z.string().trim().max(20).optional(),
    expectedArrival: z.coerce.date(),
    expectedDeparture: z.coerce.date(),
  }),
  rateLimit: { key: 'user', limit: 30, window: '1h', bucket: 'me:visitor-pass' },
  handler: async (ctx, { body }) => {
    const hostMembershipId = await meService.membershipId(ctx);
    const { pass, token } = await visitorService.createPass(ctx, { ...body, hostMembershipId });

    return {
      id: pass._id.toHexString(),
      code: pass.code,
      visitorName: pass.visitorName,
      expectedArrival: pass.expectedArrival,
      expectedDeparture: pass.expectedDeparture,
      status: pass.status,
      token,
    };
  },
});
