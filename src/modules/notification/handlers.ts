import { events } from '@/core/events';
import { createLogger } from '@/core/logging';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { membershipRepository } from '@/modules/membership/repository';
import { notificationService } from './service';

const log = createLogger('notification:handlers');

/**
 * Domain events that should tell somebody something.
 *
 * Handlers run on the event bus, which isolates their failures from whatever
 * emitted the event: a notification that cannot be delivered must never roll
 * back the payment, the emergency or the incident that caused it. The service
 * additionally swallows its own errors, so a handler failing here means
 * something structural (a missing membership, a dropped connection), not a
 * failed send.
 *
 * Every handler runs under a SYSTEM context for the estate named in the event.
 * There is no request and no user: the trigger may have been a cron sweep or a
 * webhook, and borrowing a caller's permissions would make the notification
 * depend on whoever happened to be logged in.
 */

/** Guards against double registration stacking duplicate handlers. */
let unsubscribes: Array<() => void> = [];

export function registerNotificationHandlers(): void {
  if (unsubscribes.length > 0) return;

  unsubscribes = [
    events.on('visitor.overstayed', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:visitor.overstayed');
      const { visitorPassRepository } = await import('@/modules/visitor');

      const pass = await visitorPassRepository.findById(context, payload.passId);
      if (!pass) return;

      // The HOST is told, not security: the host is the one who can ring their
      // visitor and ask them to leave, which resolves nearly all of these
      // without anyone being dispatched.
      await notificationService.send(context, {
        recipientMembershipId: payload.hostId,
        templateId: 'visitor.overstayed',
        data: {
          visitorName: pass.visitorName,
          minutesOver: payload.minutesOver,
          passCode: pass.code,
        },
        resourceType: 'visitor_pass',
        resourceId: payload.passId,
      });
    }),

    events.on('emergency.triggered', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:emergency.triggered');
      const { emergencyRepository } = await import('@/modules/emergency');

      const emergency = await emergencyRepository.findById(context, payload.emergencyId);
      if (!emergency) return;

      const responders = await securityAudience(context);

      if (responders.length === 0) {
        // Loud, because an estate with no reachable responder has an emergency
        // nobody has been told about — which is worse than a failed send.
        log.error(
          { emergencyId: payload.emergencyId, estateId: payload.estateId },
          'emergency raised but no security personnel to notify',
        );
        return;
      }

      const reporter = await membershipRepository.findById(
        context,
        emergency.triggeredByMembershipId,
      );

      await notificationService.sendMany(context, responders, {
        templateId: 'emergency.triggered',
        data: {
          reference: emergency.reference,
          type: emergency.type,
          location: emergency.location ?? 'location not given',
          reportedBy: reporter?.residentCode ?? 'a resident',
        },
        resourceType: 'emergency',
        resourceId: payload.emergencyId,
      });
    }),

    events.on('incident.created', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:incident.created');
      const { incidentRepository } = await import('@/modules/incident');

      const incident = await incidentRepository.findById(context, payload.incidentId);
      if (!incident) return;

      const responders = await securityAudience(context);
      if (responders.length === 0) return;

      await notificationService.sendMany(context, responders, {
        templateId: 'security.incident-reported',
        data: {
          reference: incident.reference,
          category: incident.category,
          severity: incident.severity,
          title: incident.title,
        },
        resourceType: 'incident',
        resourceId: payload.incidentId,
      });
    }),

    events.on('invoice.issued', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:invoice.issued');
      const { invoiceRepository } = await import('@/modules/finance');

      const invoice = await invoiceRepository.findById(context, payload.invoiceId);
      if (!invoice) return;

      await notificationService.send(context, {
        recipientMembershipId: invoice.membershipId.toHexString(),
        templateId: 'billing.invoice-issued',
        data: {
          invoiceNumber: invoice.number,
          amount: formatMinorUnits(invoice.total),
          currency: invoice.currency,
          dueDate: formatDate(invoice.dueAt),
        },
        resourceType: 'invoice',
        resourceId: payload.invoiceId,
      });
    }),

    events.on('payment.completed', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:payment.completed');
      const { invoiceRepository, paymentRepository } = await import('@/modules/finance');

      const payment = await paymentRepository.findById(context, payload.paymentId);
      if (!payment) return;

      const invoice = payment.invoiceId
        ? await invoiceRepository.findById(context, payment.invoiceId)
        : null;

      await notificationService.send(context, {
        recipientMembershipId: payment.membershipId.toHexString(),
        templateId: 'billing.payment-received',
        data: {
          invoiceNumber: invoice?.number ?? '—',
          amount: formatMinorUnits(payment.amount),
          currency: payment.currency,
          reference: payment.reference,
        },
        resourceType: 'payment',
        resourceId: payload.paymentId,
      });
    }),

    events.on('invoice.overdue', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:invoice.overdue');
      const { invoiceRepository } = await import('@/modules/finance');

      const invoice = await invoiceRepository.findById(context, payload.invoiceId);
      if (!invoice) return;

      // The resident who owes it, not the estate's finance desk: the reminder
      // exists to be acted on, and only one of those two can pay.
      await notificationService.send(context, {
        recipientMembershipId: payload.membershipId,
        templateId: 'billing.payment-overdue',
        data: {
          invoiceNumber: invoice.number,
          amount: formatMinorUnits(invoice.total - invoice.amountPaid),
          currency: invoice.currency,
          daysOverdue: payload.daysOverdue,
        },
        resourceType: 'invoice',
        resourceId: payload.invoiceId,
      });
    }),

    events.on('subscription.lapsed', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:subscription.lapsed');
      const { estateRepository } = await import('@/modules/estate');

      const estate = await estateRepository.findById(payload.estateId);
      if (!estate) return;

      const chairmen = await billingAudience(context);

      if (chairmen.length === 0) {
        // Loud for the same reason the emergency case is: an estate has just
        // gone read-only and nobody who could fix it has been told. The sweep
        // will run again tomorrow, but so will the silence.
        log.error(
          { estateId: payload.estateId },
          'estate moved to past-due but no chairman to notify',
        );
        return;
      }

      await notificationService.sendMany(context, chairmen, {
        templateId: 'billing.payment-overdue',
        data: {
          // The subscription is not an invoice in the ledger — it is billed by
          // the platform, not by the estate — so the reference names the estate
          // rather than inventing an invoice number that resolves to nothing.
          invoiceNumber: `SUBSCRIPTION-${payload.estateId.slice(-6).toUpperCase()}`,
          amount: formatMinorUnits(await subscriptionAmountMinor(estate)),
          currency: estate.settings?.currency ?? 'NGN',
          daysOverdue: payload.daysOverdue,
        },
        resourceType: 'estate',
        resourceId: payload.estateId,
      });
    }),

    events.on('resident.approved', async ({ payload }) => {
      const context = systemContext(payload.estateId, 'notification:resident.approved');
      const { estateRepository } = await import('@/modules/estate');
      const { userRepository } = await import('@/modules/user/repository');

      const membership = await membershipRepository.findById(context, payload.residentId);
      if (!membership) return;

      const [estate, user] = await Promise.all([
        estateRepository.findById(payload.estateId),
        userRepository.findById(membership.userId),
      ]);

      await notificationService.send(context, {
        recipientMembershipId: payload.residentId,
        templateId: 'account.approved',
        data: {
          name: user?.firstName ?? 'there',
          estateName: estate?.name ?? 'your estate',
          residentCode: membership.residentCode ?? 'pending',
        },
        resourceType: 'membership',
        resourceId: payload.residentId,
      });
    }),
  ];

  log.debug({ handlers: unsubscribes.length }, 'notification event handlers registered');
}

/** Test helper — drop the subscriptions this module owns. */
export function unregisterNotificationHandlers(): void {
  for (const off of unsubscribes) off();
  unsubscribes = [];
}

/**
 * Who hears about safety events.
 *
 * Category rather than role, because the question is "who is on the ground" and
 * a role grant is about what someone may do, not where they are. Suspended and
 * exited memberships are excluded: a dismissed guard must stop receiving
 * incident alerts the moment their membership is suspended.
 */
async function securityAudience(context: RequestContext): Promise<string[]> {
  const responders = await membershipRepository.findMany(context, {
    category: { $in: ['security-personnel', 'estate-staff'] },
    status: 'active',
  });

  return responders.map((membership) => membership._id.toHexString());
}

/**
 * What the estate owes the platform for its next period.
 *
 * Recomputed from the plan and the current unit count rather than stored: the
 * estate may have added units since it last paid, and quoting a stale figure in
 * a chasing email is how a payment arrives short.
 */
async function subscriptionAmountMinor(estate: {
  planCode?: string | null;
  status: string;
  _id: { toHexString(): string };
}): Promise<number> {
  const { PLANS } = await import('@/core/entitlements');
  const { PropertyModel } = await import('@/modules/property');

  const plan =
    PLANS[
      (estate.planCode ?? (estate.status === 'trial' ? 'trial' : 'starter')) as keyof typeof PLANS
    ];
  if (!plan) return 0;

  const units = await PropertyModel.countDocuments({ estateId: estate._id, deletedAt: null });
  return units * plan.pricePerUnitMonthlyMinor;
}

/**
 * Who hears that the estate's own subscription has lapsed.
 *
 * Role rather than category, because this is a question about authority, not
 * about who is on the ground: the chairman is the person who can authorise a
 * payment. Estate managers are included as a fallback — a chairman on holiday
 * must not be the reason an estate slides from grace into suspension.
 */
async function billingAudience(context: RequestContext): Promise<string[]> {
  const { roleRepository } = await import('@/modules/role');

  const roles = await roleRepository.findMany(context, {
    code: { $in: ['estate-chairman', 'estate-manager'] },
  });

  if (roles.length === 0) return [];

  const holders = await membershipRepository.findMany(context, {
    roleIds: { $in: roles.map((role) => role._id) },
    status: 'active',
  });

  return holders.map((membership) => membership._id.toHexString());
}

/** Integer minor units to a readable major-unit string: 5000000 → "50,000.00". */
function formatMinorUnits(amount: number): string {
  return (amount / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
