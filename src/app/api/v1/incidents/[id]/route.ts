import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { incidentRepository, incidentService } from '@/modules/incident';

const Params = z.object({ id: z.string() });

export const GET = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const incident = await incidentRepository.findByIdOrFail(ctx, params.id);

    return {
      id: incident._id.toHexString(),
      reference: incident.reference,
      category: incident.category,
      severity: incident.severity,
      title: incident.title,
      description: incident.description,
      status: incident.status,
      location: incident.location ?? null,
      coordinates: incident.coordinates ?? null,
      gateId: incident.gateId?.toHexString() ?? null,
      propertyId: incident.propertyId?.toHexString() ?? null,
      occurredAt: incident.occurredAt,
      reportedByMembershipId: incident.reportedByMembershipId.toHexString(),
      involvedPersons: incident.involvedPersons.map((person) => ({
        label: person.label,
        membershipId: person.membershipId?.toHexString() ?? null,
      })),
      involvedVehicles: incident.involvedVehicles.map((vehicle) => ({
        plate: vehicle.plate,
        vehicleId: vehicle.vehicleId?.toHexString() ?? null,
      })),
      attachmentIds: incident.attachmentIds.map((id) => id.toHexString()),
      assignedToMembershipId: incident.assignedToMembershipId?.toHexString() ?? null,
      assignedAt: incident.assignedAt ?? null,
      resolution: incident.resolution ?? null,
      resolvedAt: incident.resolvedAt ?? null,
      resolvedByMembershipId: incident.resolvedByMembershipId?.toHexString() ?? null,
      escalatedAt: incident.escalatedAt ?? null,
      escalationReason: incident.escalationReason ?? null,
      closedAt: incident.closedAt ?? null,
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt,
    };
  },
});

/**
 * Close an incident.
 *
 * DELETE closes; it does not delete. An incident is the record a dispute is
 * answered with, so nothing here removes one — the verb is chosen because
 * closing is the terminal action on the resource and carries no payload, not
 * because anything is discarded.
 */
export const DELETE = defineRoute({
  permissions: [PERMISSIONS.INCIDENT_CLOSE],
  params: Params,
  idempotent: true,
  handler: async (ctx, { params }) => {
    const incident = await incidentService.close(ctx, params.id);
    return { id: incident._id.toHexString(), status: incident.status, closedAt: incident.closedAt };
  },
});
