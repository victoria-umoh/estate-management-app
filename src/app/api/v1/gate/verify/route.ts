import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { verifyScan } from '@/modules/credential';

const ScanDto = z.object({
  /** The raw scanned token. */
  token: z.string().min(1).max(2000),
  gateId: z.string().optional(),
});

/**
 * Verify a scanned pass.
 *
 * Always returns 200 with an `admitted` flag. A refused scan is an ordinary
 * outcome the officer must see and the log must record — not an error, and not
 * something that should make a flaky connection look like a system failure.
 *
 * The rate limit is high because a busy gate is genuinely busy, but it is not
 * absent: an unbounded endpoint that performs crypto on every call is a
 * denial-of-service surface.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.GATE_OPERATE],
  body: ScanDto,
  status: 200,
  rateLimit: { key: 'user', limit: 600, window: '1m', bucket: 'gate:verify' },
  handler: async (ctx, { body }) => verifyScan(body.token, ctx.estateId),
});
