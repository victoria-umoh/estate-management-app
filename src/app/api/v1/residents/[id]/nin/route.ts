import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { residentService } from '@/modules/resident';

/**
 * Reveal a full NIN.
 *
 * Its own route, its own permission, and an audit entry on every read. The rate
 * limit is deliberately low: legitimate use is occasional and deliberate, so a
 * burst is a signal worth constraining rather than an inconvenience worth
 * accommodating.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_VIEW_NIN],
  params: z.object({ id: z.string() }),
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'resident:nin' },
  handler: async (ctx, { params }) => residentService.revealNin(ctx, params.id),
});
