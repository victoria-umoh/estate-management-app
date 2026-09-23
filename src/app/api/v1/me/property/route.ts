import { defineRoute } from '@/core/http';
import { meService } from '@/modules/me';

/**
 * The caller's own property.
 *
 * Returns neighbours by resident code and category only. Sharing a roof does
 * not make someone's contact details the caller's to read.
 */
export const GET = defineRoute({
  handler: async (ctx) => meService.property(ctx),
});
