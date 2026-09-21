import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { emergencyService } from '@/modules/emergency';

export const GET = defineRoute({
  permissions: [PERMISSIONS.EMERGENCY_VIEW],
  handler: async (ctx) => {
    const active = await emergencyService.listActive(ctx);

    return active.map((emergency) => ({
      id: emergency._id.toHexString(),
      reference: emergency.reference,
      type: emergency.type,
      status: emergency.status,
      description: emergency.description,
      location: emergency.location,
      coordinates: emergency.coordinates,
      contactPhone: emergency.contactPhone,
      triggeredAt: emergency.createdAt,
      acknowledgedAt: emergency.acknowledgedAt,
      responseTimeSeconds: emergency.responseTimeSeconds,
    }));
  },
});

/**
 * The panic button.
 *
 * Only `type` is required. Every other field is optional because this is
 * submitted by someone in trouble, possibly one-handed, and a validation error
 * here is a failure of the product rather than of the caller.
 *
 * The rate limit is generous for the same reason: a duplicate alert is a minor
 * annoyance, a refused one is not.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.EMERGENCY_CREATE],
  body: z.object({
    membershipId: z.string().min(1),
    type: z.enum(['medical', 'fire', 'security', 'police', 'accident', 'other']),
    description: z.string().trim().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    contactPhone: z.string().trim().max(20).optional(),
  }),
  rateLimit: { key: 'user', limit: 20, window: '5m', bucket: 'emergency:trigger' },
  handler: async (ctx, { body }) => {
    const { membershipId, ...input } = body;
    const emergency = await emergencyService.trigger(ctx, membershipId, input);

    return {
      id: emergency._id.toHexString(),
      reference: emergency.reference,
      status: emergency.status,
    };
  },
});
