import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { gateRepository, gateService } from '@/modules/gate';

const Params = z.object({ id: z.string() });
/** 24-hour clock, as the officer's rota is written. */
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour.');

export const GET = defineRoute({
  permissions: [PERMISSIONS.GATE_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const gate = await gateRepository.findByIdOrFail(ctx, params.id);

    return {
      id: gate._id.toHexString(),
      name: gate.name,
      code: gate.code,
      description: gate.description ?? null,
      status: gate.status,
      direction: gate.direction,
      opensAt: gate.opensAt ?? null,
      closesAt: gate.closesAt ?? null,
    };
  },
});

export const PATCH = defineRoute({
  permissions: [PERMISSIONS.GATE_UPDATE],
  params: Params,
  body: z.object({
    name: z.string().trim().min(2).max(80).optional(),
    code: z.string().trim().min(2).max(12).optional(),
    description: z.string().trim().max(400).nullable().optional(),
    direction: z.enum(['both', 'entry-only', 'exit-only']).optional(),
    status: z.enum(['open', 'closed', 'maintenance']).optional(),
    opensAt: Time.nullable().optional(),
    closesAt: Time.nullable().optional(),
  }),
  status: 200,
  handler: async (ctx, { params, body }) => {
    const gate = await gateService.update(ctx, params.id, body);

    return {
      id: gate._id.toHexString(),
      name: gate.name,
      code: gate.code,
      status: gate.status,
      direction: gate.direction,
    };
  },
});

export const DELETE = defineRoute({
  permissions: [PERMISSIONS.GATE_DELETE],
  params: Params,
  query: z.object({ reason: z.string().trim().min(3).max(500) }),
  idempotent: true,
  handler: async (ctx, { params, query }) => {
    await gateService.remove(ctx, params.id, query.reason);
    return { deleted: true };
  },
});
