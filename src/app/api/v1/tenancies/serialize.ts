import type { PropertyOccupancyDoc } from '@/modules/property';

/**
 * One tenancy, as the API presents it.
 *
 * Shared by the list and the detail so the two cannot drift — a tenancy that
 * reads as approved on one screen and pending on the other is worse than no
 * screen at all.
 */
export function serializeTenancy(tenancy: PropertyOccupancyDoc) {
  return {
    id: tenancy._id.toHexString(),
    propertyId: tenancy.propertyId.toHexString(),
    membershipId: tenancy.membershipId.toHexString(),
    startedAt: tenancy.startedAt,
    endedAt: tenancy.endedAt ?? null,
    endReason: tenancy.endReason ?? null,
    approvedAt: tenancy.approvedAt ?? null,
    approvedBy: tenancy.approvedBy?.toHexString() ?? null,
    leaseStartDate: tenancy.leaseStartDate ?? null,
    leaseEndDate: tenancy.leaseEndDate ?? null,
    occupantCount: tenancy.occupantCount ?? null,
    // The superseded windows travel with the record, because the question they
    // answer — who was entitled to be here, and when — is asked of the past.
    previousLeaseTerms: tenancy.previousLeaseTerms.map((term) => ({
      leaseStartDate: term.leaseStartDate ?? null,
      leaseEndDate: term.leaseEndDate ?? null,
      supersededAt: term.supersededAt,
    })),
  };
}
