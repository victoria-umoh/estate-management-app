/**
 * Domain events.
 *
 * These names are a contract in three directions: internal handlers
 * (notifications, analytics, credential-cache invalidation), the future
 * outbound-webhook surface estates subscribe to, and the IoT/device integration
 * seam. Renaming one is a breaking change; add a new name instead.
 */
export interface DomainEventMap {
  // Identity & access
  'resident.registered': { residentId: string; estateId: string };
  'resident.approved': { residentId: string; estateId: string; approvedBy: string };
  'resident.suspended': { residentId: string; estateId: string; reason: string };
  'resident.checked_in': { residentId: string; gateId: string; at: string };
  'resident.checked_out': { residentId: string; gateId: string; at: string };

  // Credentials — these drive invalidation of the gate fast-path cache
  'credential.issued': { credentialId: string; estateId: string; subject: string };
  'credential.revoked': { credentialId: string; estateId: string; reason: string };

  // Vehicles
  'vehicle.registered': { vehicleId: string; estateId: string };
  'vehicle.blacklisted': { vehicleId: string; estateId: string; reason: string };
  'vehicle.entered': { vehicleId: string; gateId: string; at: string };
  'vehicle.exited': { vehicleId: string; gateId: string; at: string };

  // Visitors
  'visitor.pass_created': { passId: string; estateId: string; hostId: string };
  'visitor.entered': { passId: string; gateId: string; at: string };
  'visitor.exited': { passId: string; gateId: string; at: string };
  'visitor.overstayed': { passId: string; estateId: string; hostId: string; minutesOver: number };
  'visitor.denied': { passId?: string; gateId: string; reason: string };

  // Exit (removal) passes
  'exitPass.created': {
    passId: string;
    estateId: string;
    requestedBy: string;
    approvalRequired: boolean;
  };
  'exitPass.approved': { passId: string; estateId: string; approvedBy: string };
  'exitPass.used': { passId: string; estateId: string; gateId: string };

  // Temporary passes
  'temporaryPass.issued': { passId: string; estateId: string; sponsorId: string };
  'temporaryPass.revoked': { passId: string; estateId: string; reason: string };

  // Safety
  'incident.created': { incidentId: string; estateId: string; severity: string };
  'incident.resolved': { incidentId: string; estateId: string };
  'emergency.triggered': { emergencyId: string; estateId: string; type: string };
  'emergency.acknowledged': { emergencyId: string; responderId: string };

  // Money
  'invoice.issued': { invoiceId: string; estateId: string; amount: number };
  'payment.completed': { paymentId: string; estateId: string; amount: number };
  'payment.failed': { paymentId: string; estateId: string; reason: string };
  /**
   * An issued invoice has passed its due date.
   *
   * Emitted once per invoice by the overdue sweep, rather than once per sweep,
   * because the person who has to be told is the one who owes the money — a
   * single "N invoices are overdue" event has nobody to send to.
   */
  'invoice.overdue': {
    invoiceId: string;
    estateId: string;
    membershipId: string;
    daysOverdue: number;
  };
  'subscription.activated': { estateId: string; planCode: string };
  'subscription.lapsed': { estateId: string; daysOverdue: number };
}

export type DomainEventName = keyof DomainEventMap;

export interface DomainEvent<TName extends DomainEventName = DomainEventName> {
  name: TName;
  payload: DomainEventMap[TName];
  /** Ties the event back to the request or job that produced it. */
  correlationId: string;
  occurredAt: Date;
}

export type EventHandler<TName extends DomainEventName> = (
  event: DomainEvent<TName>,
) => void | Promise<void>;
