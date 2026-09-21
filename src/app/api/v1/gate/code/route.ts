import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { gateService } from '@/modules/gate';

/** Admit by short code, when a QR will not scan. */
export const POST = defineRoute({
  permissions: [PERMISSIONS.GATE_OPERATE],
  body: z.object({
    code: z.string().trim().min(4).max(12),
    gateId: z.string().min(1),
    direction: z.enum(['in', 'out']),
    notes: z.string().trim().max(500).optional(),
  }),
  status: 200,
  // Tighter than the QR path: a short code is guessable in a way a signed token
  // is not, so repeated attempts are throttled.
  rateLimit: { key: 'user', limit: 60, window: '1m', bucket: 'gate:code' },
  handler: async (ctx, { body }) => gateService.admitByCode(ctx, body),
});
