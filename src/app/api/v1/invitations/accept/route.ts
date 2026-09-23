import { defineRoute } from '@/core/http';
import { AcceptInvitationDto, accountService } from '@/modules/auth';

/**
 * Accept an invitation and create the account.
 *
 * Public: the invitee has no account yet, which is the entire point. The token
 * is the authorisation, and it carries the estate, the property and the
 * category — none of which the body may name.
 */
export const POST = defineRoute({
  auth: false,
  body: AcceptInvitationDto,
  rateLimit: { key: 'ip', limit: 5, window: '15m', bucket: 'invitation:accept' },
  handler: async (_ctx, { body }) => accountService.acceptInvitation(body.token, body),
});
