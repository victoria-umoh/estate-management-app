import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, searchService } from '@/modules/search';

const SearchDto = z.object({
  q: z.string().trim().min(MIN_QUERY_LENGTH).max(MAX_QUERY_LENGTH),
  limit: z.coerce.number().int().positive().max(10).optional(),
});

/**
 * Global search.
 *
 * Deliberately declares NO route-level permission. Requiring one would either
 * be so broad it means nothing, or would lock out the residents who legitimately
 * search the property directory. Authorisation happens per result type inside
 * the service, which computes a block only if the caller holds the permission
 * its own list endpoint requires — so what comes back is always a subset of
 * what the caller could already reach.
 *
 * Auth is still mandatory: `defineRoute` requires a session unless `auth` is
 * false, and the service asserts a tenant context on top of that.
 *
 * Rate limited because this fires on keystrokes, and because an unthrottled
 * exact-match endpoint over codes and references is an enumeration tool.
 */
export const GET = defineRoute({
  query: SearchDto,
  rateLimit: { key: 'user', limit: 120, window: '1m', bucket: 'search' },
  handler: async (ctx, { query }) => searchService.search(ctx, query),
});
