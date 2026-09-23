import { defineRoute } from '@/core/http';
import { meService } from '@/modules/me';

/** The caller's own profile. No permission beyond being signed in. */
export const GET = defineRoute({
  handler: async (ctx) => meService.profile(ctx),
});
