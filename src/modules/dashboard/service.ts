import { PERMISSIONS, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { EmergencyModel } from '@/modules/emergency';
import { InvoiceModel } from '@/modules/finance';
import { IncidentModel } from '@/modules/incident';
import { meService } from '@/modules/me';
import { MembershipModel } from '@/modules/membership/schema';
import { MovementModel } from '@/modules/movement';
import { PropertyModel } from '@/modules/property';
import { ServiceRequestModel } from '@/modules/service-request';
import { VisitorPassModel } from '@/modules/visitor/schema';

/**
 * The landing screen's numbers.
 *
 * Assembled per caller rather than per role. A permission check decides whether
 * each block is computed at all, so a chairman who is also a resident sees both,
 * and nothing is computed for someone who could not be shown it anyway — which
 * matters because several of these are estate-wide counts.
 *
 * Every block is independently optional in the response. The alternative —
 * refusing the whole dashboard when one permission is missing — would leave
 * most residents staring at a 403 on the first screen after sign-in.
 */
export interface DashboardResponse {
  resident?: {
    outstandingMinor: number;
    unpaidInvoices: number;
    activeVisitorPasses: number;
    visitorsInsideNow: number;
    householdSize: number;
    openRequests: number;
    unitNumber: string | null;
  };
  security?: {
    visitorsInside: number;
    overstaying: number;
    activeEmergencies: number;
    openIncidents: number;
    movementsToday: number;
    deniedToday: number;
  };
  estate?: {
    residents: number;
    pendingApprovals: number;
    properties: number;
    occupiedProperties: number;
    openIncidents: number;
    openRequests: number;
  };
  finance?: {
    outstandingMinor: number;
    collectedMinor: number;
    overdueInvoices: number;
  };
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export class DashboardService {
  async load(context: RequestContext): Promise<DashboardResponse> {
    const estateId = context.estateId;
    const response: DashboardResponse = {};

    // Resolved once. A membership is required for the resident block and
    // harmless to skip for platform staff who have none.
    const membership = await meService.membership(context).catch(() => null);

    const tasks: Array<Promise<void>> = [];

    if (membership) {
      tasks.push(
        (async () => {
          const [invoices, passes, inside, household, requests] = await Promise.all([
            InvoiceModel.find(
              {
                estateId,
                membershipId: membership._id,
                status: { $in: ['issued', 'partially-paid', 'overdue'] },
                deletedAt: null,
              },
              { total: 1, amountPaid: 1 },
            ).lean(),
            VisitorPassModel.countDocuments({
              estateId,
              hostMembershipId: membership._id,
              status: 'pending',
              deletedAt: null,
            }),
            VisitorPassModel.countDocuments({
              estateId,
              hostMembershipId: membership._id,
              status: 'inside',
              deletedAt: null,
            }),
            MembershipModel.countDocuments({
              estateId,
              propertyId: membership.propertyId,
              status: 'active',
              deletedAt: null,
            }),
            ServiceRequestModel.countDocuments({
              estateId,
              requestedByMembershipId: membership._id,
              status: { $nin: ['resolved', 'closed'] },
              deletedAt: null,
            }),
          ]);

          const property = membership.propertyId
            ? await PropertyModel.findById(membership.propertyId, { unitNumber: 1 }).lean()
            : null;

          response.resident = {
            outstandingMinor: invoices.reduce((sum, i) => sum + (i.total - i.amountPaid), 0),
            unpaidInvoices: invoices.length,
            activeVisitorPasses: passes,
            visitorsInsideNow: inside,
            householdSize: household,
            openRequests: requests,
            unitNumber: property?.unitNumber ?? null,
          };
        })(),
      );
    }

    if (can(context, PERMISSIONS.GATE_LOG_VIEW) || can(context, PERMISSIONS.VISITOR_VERIFY)) {
      tasks.push(
        (async () => {
          const since = startOfToday();
          const now = new Date();

          const [inside, overstaying, emergencies, incidents, movements, denied] =
            await Promise.all([
              VisitorPassModel.countDocuments({ estateId, status: 'inside', deletedAt: null }),
              VisitorPassModel.countDocuments({
                estateId,
                status: 'inside',
                expectedDeparture: { $lt: now },
                deletedAt: null,
              }),
              EmergencyModel.countDocuments({
                estateId,
                status: { $nin: ['resolved', 'closed'] },
                deletedAt: null,
              }),
              IncidentModel.countDocuments({
                estateId,
                status: { $nin: ['resolved', 'closed'] },
                deletedAt: null,
              }),
              MovementModel.countDocuments({ estateId, occurredAt: { $gte: since } }),
              MovementModel.countDocuments({
                estateId,
                admitted: false,
                occurredAt: { $gte: since },
              }),
            ]);

          response.security = {
            visitorsInside: inside,
            overstaying,
            activeEmergencies: emergencies,
            openIncidents: incidents,
            movementsToday: movements,
            deniedToday: denied,
          };
        })(),
      );
    }

    // Deliberately not `estate.view`, which every resident holds — this block
    // carries the approval queue, and a management count on a resident's
    // landing screen is both noise and a small disclosure.
    if (can(context, PERMISSIONS.RESIDENT_APPROVE)) {
      tasks.push(
        (async () => {
          const [residents, pending, properties, occupied, incidents, requests] =
            await Promise.all([
              MembershipModel.countDocuments({ estateId, status: 'active', deletedAt: null }),
              MembershipModel.countDocuments({
                estateId,
                status: 'awaiting-approval',
                deletedAt: null,
              }),
              PropertyModel.countDocuments({ estateId, deletedAt: null }),
              PropertyModel.countDocuments({
                estateId,
                occupancyStatus: { $in: ['owner-occupied', 'tenant-occupied'] },
                deletedAt: null,
              }),
              IncidentModel.countDocuments({
                estateId,
                status: { $nin: ['resolved', 'closed'] },
                deletedAt: null,
              }),
              ServiceRequestModel.countDocuments({
                estateId,
                status: { $nin: ['resolved', 'closed'] },
                deletedAt: null,
              }),
            ]);

          response.estate = {
            residents,
            pendingApprovals: pending,
            properties,
            occupiedProperties: occupied,
            openIncidents: incidents,
            openRequests: requests,
          };
        })(),
      );
    }

    if (can(context, PERMISSIONS.LEDGER_VIEW)) {
      tasks.push(
        (async () => {
          const [unpaid, overdue, paid] = await Promise.all([
            InvoiceModel.find(
              {
                estateId,
                status: { $in: ['issued', 'partially-paid', 'overdue'] },
                deletedAt: null,
              },
              { total: 1, amountPaid: 1 },
            ).lean(),
            InvoiceModel.countDocuments({ estateId, status: 'overdue', deletedAt: null }),
            InvoiceModel.find({ estateId, deletedAt: null }, { amountPaid: 1 }).lean(),
          ]);

          response.finance = {
            outstandingMinor: unpaid.reduce((sum, i) => sum + (i.total - i.amountPaid), 0),
            collectedMinor: paid.reduce((sum, i) => sum + i.amountPaid, 0),
            overdueInvoices: overdue,
          };
        })(),
      );
    }

    await Promise.all(tasks);
    return response;
  }
}

export const dashboardService = new DashboardService();
