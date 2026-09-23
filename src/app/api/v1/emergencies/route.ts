import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { emergencyRepository, emergencyService, type EmergencyDoc } from '@/modules/emergency';

/**
 * Identity is returned as membership ids, not names.
 *
 * Resolving a name means a lookup per alert on the screen that has to render
 * fastest in the building. The caller can resolve the handful of ids it needs;
 * this path stays a single indexed read.
 */
function project(emergency: EmergencyDoc) {
  return {
    id: emergency._id.toHexString(),
    reference: emergency.reference,
    type: emergency.type,
    status: emergency.status,
    description: emergency.description,
    location: emergency.location,
    coordinates: emergency.coordinates,
    contactPhone: emergency.contactPhone,
    propertyId: emergency.propertyId?.toHexString() ?? null,
    triggeredByMembershipId: emergency.triggeredByMembershipId.toHexString(),
    triggeredAt: emergency.createdAt,
    acknowledgedAt: emergency.acknowledgedAt,
    acknowledgedByMembershipId: emergency.acknowledgedByMembershipId?.toHexString() ?? null,
    responseTimeSeconds: emergency.responseTimeSeconds,
    respondingAt: emergency.respondingAt ?? null,
    resolvedAt: emergency.resolvedAt ?? null,
    resolvedByMembershipId: emergency.resolvedByMembershipId?.toHexString() ?? null,
    outcome: emergency.outcome ?? null,
  };
}

export const GET = defineRoute({
  permissions: [PERMISSIONS.EMERGENCY_VIEW],
  query: z.object({
    // Optional, and active-only remains the default. A life-safety screen must
    // show live alerts without anyone first choosing a filter; history is the
    // deliberate request, not the other way round.
    status: z
      .enum(['triggered', 'acknowledged', 'responding', 'resolved', 'false-alarm'])
      .optional(),
  }),
  handler: async (ctx, { query }) => {
    if (!query.status) {
      const active = await emergencyService.listActive(ctx);
      return active.map(project);
    }

    const matching = await emergencyRepository.findMany(
      ctx,
      { status: query.status },
      { sort: { createdAt: -1 } },
    );

    return matching.map(project);
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
