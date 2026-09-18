import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { authService, RefreshDto } from '@/modules/auth';

export const POST = defineRoute({
  auth: false,
  status: 200,
  body: RefreshDto.extend({ allDevices: z.boolean().optional() }),
  handler: async (_ctx, { body }) => {
    await authService.logout(body.refreshToken);
    return { loggedOut: true };
  },
});
