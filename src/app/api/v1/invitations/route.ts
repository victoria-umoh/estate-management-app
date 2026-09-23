import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { accountService, InviteResidentDto } from '@/modules/auth';

/**
 * Invite someone into the estate.
 *
 * Authenticated and permission-gated — this one is not anonymous, because it
 * sends mail in the estate's name and the estate is entitled to know who did.
 * The limit is per user rather than per IP for the same reason: an office
 * behind one address may have several administrators legitimately working
 * through a move-in list.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_CREATE],
  requiresActiveSubscription: true,
  body: InviteResidentDto,
  rateLimit: { key: 'user', limit: 30, window: '1h', bucket: 'invitation:create' },
  handler: async (ctx, { body }) => accountService.inviteResident(ctx, body),
});
