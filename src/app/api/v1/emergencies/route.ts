import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS, can } from '@/core/rbac';
import { meService } from '@/modules/me';
import { emergencyService, type EmergencyDoc } from '@/modules/emergency';

/**
 * Identity is returned as membership ids, not names.
 *
 * Resolving a name means a lookup per alert on the screen that has to render
 * fastest in the building. The caller can resolve the handful of ids it needs;
 * this path stays a single indexed read.
 */
function project(emergency: EmergencyDoc, full: boolean) {
  return {
    id: emergency._id.toHexString(),
    reference: emergency.reference,
    type: emergency.type,
    status: emergency.status,
    triggeredAt: emergency.createdAt,
    acknowledgedAt: emergency.acknowledgedAt,

    // Everything below identifies or locates the person who raised the alarm.
    // A resident may know an alert is live; they have no need for the caller's
    // phone number, their coordinates or their unit.
    ...(full ? operationalDetail(emergency) : {}),
  };
}

function operationalDetail(emergency: EmergencyDoc) {
  return {
    description: emergency.description,
    location: emergency.location,
    coordinates: emergency.coordinates,
    contactPhone: emergency.contactPhone,
    propertyId: emergency.propertyId?.toHexString() ?? null,
    triggeredByMembershipId: emergency.triggeredByMembershipId.toHexString(),
    acknowledgedByMembershipId: emergency.acknowledgedByMembershipId?.toHexString() ?? null,
    responseTimeSeconds: emergency.responseTimeSeconds,
    respondingAt: emergency.respondingAt ?? null,
    resolvedAt: emergency.resolvedAt ?? null,
    resolvedByMembershipId: emergency.resolvedByMembershipId?.toHexString() ?? null,
    outcome: emergency.outcome ?? null,
  };
}

/**
 * Active emergencies.
 *
 * Every resident may know that an alert is live in their estate — that is a
 * community safety matter, and hiding it would be the wrong call. What they may
 * not have is the free-text description, the GPS coordinates, the phone number
 * of the neighbour who raised it, or which unit it came from.
 *
 * So this narrows the projection rather than the rows. `emergency.viewAll`
 * returns the operational detail a responder needs; without it the answer is
 * that something is happening, of what kind, and since when.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.EMERGENCY_VIEW],
  handler: async (ctx) => {
    const active = await emergencyService.listActive(ctx);
    const full = can(ctx, PERMISSIONS.EMERGENCY_VIEW_ALL);

    return active.map((emergency) => project(emergency, full));
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.EMERGENCY_CREATE],
  body: z.object({
    type: z.enum(['medical', 'fire', 'security', 'police', 'accident', 'other']),
    description: z.string().trim().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    contactPhone: z.string().trim().max(20).optional(),
  }),
  rateLimit: { key: 'user', limit: 20, window: '5m', bucket: 'emergency:trigger' },
  handler: async (ctx, { body }) => {
    // The person in trouble is the caller. Taking this from the body let any
    // resident raise a panic alert attributed to a neighbour — dispatching
    // security to that neighbour's house, stamped with their property, and
    // audited in their name.
    const membershipId = await meService.membershipId(ctx);
    const emergency = await emergencyService.trigger(ctx, membershipId, body);

    return {
      id: emergency._id.toHexString(),
      reference: emergency.reference,
      status: emergency.status,
    };
  },
});
