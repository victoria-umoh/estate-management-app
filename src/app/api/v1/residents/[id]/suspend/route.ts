import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { residentService } from '@/modules/resident';

/**
 * Suspend a resident.
 *
 * Separate from the approve/reject decision because it is a different act on a
 * different subject: rejection turns away someone who never got in, suspension
 * takes access away from someone who has it — and revokes the credentials that
 * would otherwise keep opening the gate.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_SUSPEND],
  params: z.object({ id: z.string() }),
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
  idempotent: true,
  status: 200,
  handler: async (ctx, { params, body }) => {
    const membership = await residentService.suspend(ctx, params.id, body.reason);
    return { status: membership.status, reason: membership.rejectionReason ?? null };
  },
});
