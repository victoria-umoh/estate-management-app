import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { meService } from '@/modules/me';
import { visitorPassRepository, visitorService } from '@/modules/visitor';

export const GET = defineRoute({
  permissions: [PERMISSIONS.VISITOR_VIEW],
  query: z.object({
    status: z.enum(['pending', 'inside', 'completed', 'expired', 'cancelled', 'denied']).optional(),
    hostMembershipId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;

    // Residents hold `visitor.view` for their own guests. Without this the list
    // returned every household's visitor log — who called, why, and whether
    // they are still inside, which is live occupancy data.
    const scope = await meService.narrowUnless(
      ctx,
      PERMISSIONS.VISITOR_VIEW_ALL,
      'hostMembershipId',
    );

    const result = await visitorPassRepository.paginate(
      ctx,
      { ...filters, ...scope },
      { page, limit },
      {
        sort: { createdAt: -1 },
      },
    );

    return paginated({
      ...result,
      items: result.items.map((pass) => ({
        id: pass._id.toHexString(),
        code: pass.code,
        passType: pass.passType,
        visitorName: pass.visitorName,
        purpose: pass.purpose,
        partySize: pass.partySize,
        status: pass.status,
        expectedArrival: pass.expectedArrival,
        expectedDeparture: pass.expectedDeparture,
        checkedInAt: pass.checkedInAt,
        checkedOutAt: pass.checkedOutAt,
        overstaying: pass.status === 'inside' && pass.expectedDeparture < new Date(),
      })),
    });
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.VISITOR_CREATE],
  body: z.object({
    hostMembershipId: z.string().min(1),
    visitorName: z.string().trim().min(2).max(120),
    visitorPhone: z.string().trim().max(20).optional(),
    partySize: z.number().int().min(1).max(100).optional(),
    purpose: z.string().trim().min(2).max(200),
    vehiclePlate: z.string().trim().max(20).optional(),
    expectedArrival: z.coerce.date(),
    expectedDeparture: z.coerce.date(),
  }),
  rateLimit: { key: 'user', limit: 30, window: '1h', bucket: 'visitor:create' },
  handler: async (ctx, { body }) => {
    const { pass, token } = await visitorService.createPass(ctx, body);

    return {
      id: pass._id.toHexString(),
      // Both are returned once: the code for reading aloud, the token for the
      // QR the guest is sent.
      code: pass.code,
      token,
      expectedArrival: pass.expectedArrival,
      expectedDeparture: pass.expectedDeparture,
    };
  },
});
