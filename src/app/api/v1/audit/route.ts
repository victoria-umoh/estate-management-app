import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { auditRepository } from '@/modules/audit';

const AuditQueryDto = z.object({
  action: z.string().max(80).optional(),
  resource: z.string().max(80).optional(),
  resourceId: z.string().max(64).optional(),
  actorId: z.string().max(64).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

/**
 * Read the audit trail.
 *
 * Read-only by design: there is deliberately no POST, PATCH or DELETE on this
 * resource anywhere in the API.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.AUDIT_VIEW],
  query: AuditQueryDto,
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await auditRepository.search(ctx, filters, { page, limit });
    return paginated(result);
  },
});
