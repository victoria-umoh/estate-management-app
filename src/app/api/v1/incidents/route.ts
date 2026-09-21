import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { incidentService } from '@/modules/incident';

const CATEGORIES = [
  'theft',
  'security-breach',
  'suspicious-activity',
  'property-damage',
  'noise',
  'parking',
  'fire',
  'flood',
  'medical',
  'accident',
  'power',
  'water',
  'other',
] as const;

export const GET = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_VIEW],
  query: z.object({
    status: z
      .enum(['open', 'assigned', 'investigating', 'resolved', 'closed', 'escalated'])
      .optional(),
    category: z.enum(CATEGORIES).optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    assignedToMembershipId: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  }),
  handler: async (ctx, { query }) => {
    const { page, limit, ...filters } = query;
    const result = await incidentService.list(ctx, filters, { page, limit });

    return paginated({
      ...result,
      items: result.items.map((incident) => ({
        id: incident._id.toHexString(),
        reference: incident.reference,
        category: incident.category,
        severity: incident.severity,
        title: incident.title,
        status: incident.status,
        location: incident.location,
        occurredAt: incident.occurredAt,
        assignedToMembershipId: incident.assignedToMembershipId?.toHexString() ?? null,
      })),
    });
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_CREATE],
  body: z.object({
    reporterMembershipId: z.string().min(1),
    category: z.enum(CATEGORIES),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    title: z.string().trim().min(4).max(160),
    description: z.string().trim().min(4).max(5000),
    occurredAt: z.coerce.date().optional(),
    location: z.string().trim().max(200).optional(),
    coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
    gateId: z.string().optional(),
    propertyId: z.string().optional(),
    involvedPersons: z
      .array(z.object({ label: z.string().trim().max(160), membershipId: z.string().optional() }))
      .max(20)
      .optional(),
    involvedVehicles: z
      .array(z.object({ plate: z.string().trim().max(20), vehicleId: z.string().optional() }))
      .max(20)
      .optional(),
    attachmentIds: z.array(z.string()).max(20).optional(),
  }),
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'incident:report' },
  handler: async (ctx, { body }) => {
    const { reporterMembershipId, ...input } = body;
    const incident = await incidentService.report(ctx, reporterMembershipId, input);

    return {
      id: incident._id.toHexString(),
      reference: incident.reference,
      status: incident.status,
    };
  },
});
