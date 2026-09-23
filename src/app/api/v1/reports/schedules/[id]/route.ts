import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { reportScheduleService } from '@/modules/report';

export const PATCH = defineRoute({
  permissions: [PERMISSIONS.REPORT_SCHEDULE],
  params: z.object({ id: z.string() }),
  body: z.object({ active: z.boolean() }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const schedule = await reportScheduleService.setActive(ctx, params.id, body.active);
    return { id: schedule._id.toHexString(), active: schedule.active };
  },
});

export const DELETE = defineRoute({
  permissions: [PERMISSIONS.REPORT_SCHEDULE],
  params: z.object({ id: z.string() }),
  status: 200,
  handler: async (ctx, { params }) => {
    await reportScheduleService.remove(ctx, params.id);
    return { deleted: true };
  },
});
