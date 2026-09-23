import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { movementService } from '@/modules/movement';

export const GET = defineRoute({
  permissions: [PERMISSIONS.GATE_LOG_VIEW],
  query: z.object({
    gateId: z.string().optional(),
    direction: z.enum(['in', 'out']).optional(),
    subject: z.enum(['resident', 'vehicle', 'visitor', 'exit-pass', 'temporary-pass']).optional(),
    admitted: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await movementService.recent(ctx, filters, { page, limit });

    return paginated({
      ...result,
      items: result.items.map((movement) => ({
        id: movement._id.toHexString(),
        direction: movement.direction,
        subject: movement.subject,
        label: movement.subjectLabel,
        unitNumber: movement.unitNumber,
        vehiclePlate: movement.vehiclePlate,
        admitted: movement.admitted,
        denialReason: movement.denialReason,
        method: movement.method,
        occurredAt: movement.occurredAt,
      })),
    });
  },
});
