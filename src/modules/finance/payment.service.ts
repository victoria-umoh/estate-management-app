import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { config } from '@/core/config';
import { BaseRepository, withTransaction } from '@/core/db';
import { events } from '@/core/events';
import { ConflictError, NotFoundError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { getPaymentProvider } from '@/integrations/payments';
import { auditService } from '@/modules/audit';
import { estateRepository } from '@/modules/estate';
import { userRepository } from '@/modules/user/repository';
import { ledgerService } from './ledger.service';
import {
  InvoiceModel,
  PaymentModel,
  WebhookEventModel,
  type InvoiceDoc,
  type PaymentDoc,
} from './schema';

const log = createLogger('payment');

/** MongoDB's duplicate-key code, which is how the idempotency claim reports a repeat. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: number }).code === 11000 ||
      /E11000|duplicate key/i.test(String((error as { message?: string }).message ?? '')))
  );
}

class PaymentRepository extends BaseRepository<PaymentDoc> {
  constructor() {
    super(PaymentModel);
  }
}

class InvoiceRepository extends BaseRepository<InvoiceDoc> {
  constructor() {
    super(InvoiceModel);
  }
}

export const paymentRepository = new PaymentRepository();
export const invoiceRepository = new InvoiceRepository();

/** Our own reference. Prefixed so it is recognisable in a provider dashboard. */
function generateReference(): string {
  return `EOS-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export class PaymentService {
  /**
   * Begin a payment and hand back a checkout URL.
   *
   * The record is created as `pending` before the provider is called, so a
   * provider response that arrives while the browser is closing still has a row
   * to attach to. Creating it afterwards would lose payments taken during a
   * crash — the worst possible thing to lose.
   */
  async initialize(
    context: RequestContext,
    input: { invoiceId: string; membershipId: string; email: string },
  ): Promise<{ authorizationUrl: string; reference: string }> {
    assertCan(context, PERMISSIONS.PAYMENT_CREATE);

    const invoice = await invoiceRepository.findByIdOrFail(context, input.invoiceId);

    if (invoice.status === 'paid') {
      throw new ConflictError('That invoice is already paid.');
    }
    if (invoice.status === 'cancelled') {
      throw new ConflictError('That invoice has been cancelled.');
    }

    const outstanding = invoice.total - invoice.amountPaid;
    if (outstanding <= 0) {
      throw new ConflictError('There is nothing outstanding on that invoice.');
    }

    const reference = generateReference();
    const estate = await estateRepository.findById(context.estateId);

    const payment = await paymentRepository.create(context, {
      reference,
      invoiceId: invoice._id,
      membershipId: new Types.ObjectId(input.membershipId),
      amount: outstanding,
      currency: invoice.currency,
      provider: 'paystack',
      status: 'pending',
      providerFee: 0,
      recordedBy: new Types.ObjectId(context.userId),
    });

    const provider = await getPaymentProvider();

    const initialized = await provider.initialize({
      reference,
      amount: outstanding,
      currency: invoice.currency,
      email: input.email,
      ...(config.payments.paystack.callbackUrl
        ? { callbackUrl: config.payments.paystack.callbackUrl }
        : {}),
      // Settles to the estate rather than the platform.
      ...(estate?.paystackSubaccountCode ? { subaccountCode: estate.paystackSubaccountCode } : {}),
      metadata: { invoiceNumber: invoice.number, estateId: context.estateId },
    });

    await paymentRepository.updateById(context, payment._id, {
      $set: { providerReference: initialized.providerReference },
    });

    return { authorizationUrl: initialized.authorizationUrl, reference };
  }

  /**
   * Settle a payment against its invoice and the ledger.
   *
   * Reached only from server-side verification or a signed webhook — never from
   * the browser. The whole settlement is one transaction: the payment, the
   * invoice and the ledger move together or not at all, because an invoice
   * marked paid with no ledger entry is a silent error that surfaces months
   * later during reconciliation.
   *
   * Idempotent. A webhook and a verify call routinely both arrive for the same
   * payment, and crediting twice would be a real loss to the estate.
   */
  private async settle(
    context: RequestContext,
    payment: PaymentDoc,
    settlement: {
      providerReference: string;
      fee: number;
      method?: string;
      paidAt: Date;
      source: 'webhook' | 'api-verify' | 'manual';
    },
  ): Promise<void> {
    if (payment.status === 'successful') {
      log.debug({ reference: payment.reference }, 'payment already settled; ignoring');
      return;
    }

    await withTransaction(async (session) => {
      await paymentRepository.updateById(
        context,
        payment._id,
        {
          $set: {
            status: 'successful',
            providerReference: settlement.providerReference,
            providerFee: settlement.fee,
            method: settlement.method ?? null,
            paidAt: settlement.paidAt,
            verifiedAt: new Date(),
            verificationSource: settlement.source,
          },
        },
        { session },
      );

      // Money in: cash rises, the resident owes less.
      await ledgerService.post(context, {
        description: `Payment ${payment.reference}`,
        currency: payment.currency,
        postings: [
          { account: 'cash', direction: 'debit', amount: payment.amount - settlement.fee },
          { account: 'payment-fees', direction: 'debit', amount: settlement.fee },
          { account: 'accounts-receivable', direction: 'credit', amount: payment.amount },
        ],
        paymentId: payment._id,
        ...(payment.invoiceId ? { invoiceId: payment.invoiceId } : {}),
        membershipId: payment.membershipId,
        occurredAt: settlement.paidAt,
        session,
      });

      if (payment.invoiceId) {
        const invoice = await invoiceRepository.findById(context, payment.invoiceId, { session });

        if (invoice) {
          const amountPaid = invoice.amountPaid + payment.amount;
          const fullySettled = amountPaid >= invoice.total;

          await invoiceRepository.updateById(
            context,
            invoice._id,
            {
              $set: {
                amountPaid,
                status: fullySettled ? 'paid' : 'partially-paid',
                ...(fullySettled ? { paidAt: settlement.paidAt } : {}),
              },
            },
            { session },
          );
        }
      }

      await auditService.record(context, {
        action: 'payment.verified',
        resource: 'payment',
        resourceId: payment._id,
        metadata: {
          reference: payment.reference,
          amount: payment.amount,
          source: settlement.source,
        },
        session,
      });
    });

    events.emit('payment.completed', {
      paymentId: payment._id.toHexString(),
      estateId: context.estateId,
      amount: payment.amount,
    });

    log.info(
      { reference: payment.reference, amount: payment.amount, source: settlement.source },
      'payment settled',
    );
  }

  /**
   * Ask the provider whether a payment settled, and act on the answer.
   *
   * Called when the payer returns from checkout. The return itself proves
   * nothing — that redirect is trivially forged — so the reference is only ever
   * used to look up the payment and ask the provider directly.
   */
  async verify(context: RequestContext, reference: string): Promise<PaymentDoc> {
    const payment = await paymentRepository.findOne(context, { reference });
    if (!payment) throw new NotFoundError('Payment');

    if (payment.status === 'successful') return payment;

    const provider = await getPaymentProvider();
    const result = await provider.verify(reference);

    if (!result.successful) {
      await paymentRepository.updateById(context, payment._id, {
        $set: {
          status: 'failed',
          failureReason: result.failureReason ?? 'Payment was not completed',
          verifiedAt: new Date(),
          verificationSource: 'api-verify',
        },
      });

      events.emit('payment.failed', {
        paymentId: payment._id.toHexString(),
        estateId: context.estateId,
        reason: result.failureReason ?? 'unknown',
      });

      return paymentRepository.findByIdOrFail(context, payment._id);
    }

    // The provider is authoritative on amount. A mismatch means the payer was
    // charged something other than what we recorded, which must be investigated
    // rather than quietly accepted.
    if (result.amount !== payment.amount) {
      log.error(
        { reference, expected: payment.amount, actual: result.amount },
        'payment amount mismatch',
      );
      throw new UnprocessableError(
        'The amount paid does not match the amount due. This has been flagged for review.',
      );
    }

    await this.settle(context, payment, {
      providerReference: result.providerReference,
      fee: result.fee,
      ...(result.method ? { method: result.method } : {}),
      paidAt: result.paidAt ?? new Date(),
      source: 'api-verify',
    });

    return paymentRepository.findByIdOrFail(context, payment._id);
  }

  /**
   * Handle a provider webhook.
   *
   * Runs without a request context: a webhook is an unauthenticated POST from
   * outside, and the estate is discovered from the payment the reference names.
   *
   * Two guards, both necessary. The signature is checked against the raw body,
   * because anyone can POST to this URL. And the event id is recorded under a
   * unique index, because providers retry — especially when something went
   * wrong — so duplicate delivery is routine rather than exceptional.
   */
  async handleWebhook(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const provider = await getPaymentProvider();
    const verification = provider.verifyWebhook(rawBody, signatureHeader);

    if (!verification.valid) {
      log.warn('rejected webhook with an invalid signature');
      return { accepted: false, reason: 'invalid-signature' };
    }

    // Claiming the event id before doing any work. If this insert fails on the
    // unique index, another delivery of the same event is already in hand.
    try {
      await WebhookEventModel.create({
        provider: provider.name,
        eventId: verification.eventId,
        eventType: verification.eventType,
        signatureValid: true,
      });
    } catch (error) {
      // Only a duplicate key means "already in hand". Any other failure — a
      // validation error, a transient write problem, a replica-set blip — was
      // previously reported to the provider as a handled duplicate, and a
      // provider does not retry a 200. The payment would simply never settle,
      // with nothing above debug to say why. Anything else rethrows into the
      // route's 500, which is what makes the provider try again.
      if (!isDuplicateKeyError(error)) throw error;

      log.debug({ eventId: verification.eventId }, 'duplicate webhook ignored');
      return { accepted: true, reason: 'duplicate' };
    }

    if (!verification.reference) {
      return { accepted: true, reason: 'no-reference' };
    }

    // Looked up without a tenant context, because a webhook arrives before any
    // estate is known. The reference is ours and unique platform-wide.
    const payment = await PaymentModel.findOne({ reference: verification.reference }).lean();

    if (!payment) {
      log.warn({ reference: verification.reference }, 'webhook for an unknown payment');
      return { accepted: true, reason: 'unknown-payment' };
    }

    const context = systemContext(payment.estateId.toHexString(), 'paystack-webhook');

    if (verification.eventType === 'charge.success') {
      // Verified against the provider's API rather than trusting the webhook
      // body's amount. The signature proves the message came from the provider;
      // it does not prove the body was not replayed from a smaller charge.
      const result = await provider.verify(verification.reference);

      if (result.successful && result.amount === payment.amount) {
        await this.settle(context, payment as PaymentDoc, {
          providerReference: result.providerReference,
          fee: result.fee,
          ...(result.method ? { method: result.method } : {}),
          paidAt: result.paidAt ?? new Date(),
          source: 'webhook',
        });
      } else {
        log.error(
          { reference: verification.reference, expected: payment.amount, actual: result.amount },
          'webhook charge.success did not verify',
        );
      }
    }

    await WebhookEventModel.updateOne(
      { provider: provider.name, eventId: verification.eventId },
      { $set: { processedAt: new Date() } },
    );

    return { accepted: true };
  }

  /**
   * Record a payment taken outside the platform — cash, direct transfer.
   *
   * Separate permission from `payment.create`, because this credits an account
   * on nothing but a person's word and is the obvious route to writing off a
   * debt quietly. Audited with the recorder named.
   */
  async recordManual(
    context: RequestContext,
    input: { invoiceId: string; membershipId: string; amount: number; note: string },
  ): Promise<PaymentDoc> {
    assertCan(context, PERMISSIONS.PAYMENT_VERIFY);

    const invoice = await invoiceRepository.findByIdOrFail(context, input.invoiceId);

    if (input.amount <= 0) {
      throw new UnprocessableError('A payment must be for more than zero.');
    }
    if (input.amount > invoice.total - invoice.amountPaid) {
      throw new UnprocessableError('That is more than the amount outstanding.');
    }

    const payment = await paymentRepository.create(context, {
      reference: generateReference(),
      invoiceId: invoice._id,
      membershipId: new Types.ObjectId(input.membershipId),
      amount: input.amount,
      currency: invoice.currency,
      provider: 'manual',
      status: 'pending',
      providerFee: 0,
      recordedBy: new Types.ObjectId(context.userId),
    });

    await this.settle(context, payment, {
      providerReference: `manual:${payment.reference}`,
      fee: 0,
      method: 'manual',
      paidAt: new Date(),
      source: 'manual',
    });

    await auditService.record(context, {
      action: 'payment.recorded_manually',
      resource: 'payment',
      resourceId: payment._id,
      metadata: { amount: input.amount, note: input.note, invoiceNumber: invoice.number },
    });

    return paymentRepository.findByIdOrFail(context, payment._id);
  }
  /**
   * Start a payment on the caller's own invoice.
   *
   * Both the membership and the billing email come from the session. A route
   * that accepted either from the request would let a resident open a checkout
   * against another household's invoice, or have the receipt sent elsewhere.
   */
  async initializeForCaller(
    context: RequestContext,
    invoiceId: string,
  ): Promise<{ authorizationUrl: string; reference: string }> {
    const { invoiceService } = await import('./invoice.service');

    const membershipId = await invoiceService.callerMembershipId(context);
    await invoiceService.assertBelongsTo(context, invoiceId, membershipId);

    const user = await userRepository.findById(context.userId);
    if (!user) throw new NotFoundError('User');

    return this.initialize(context, { invoiceId, membershipId, email: user.email });
  }
}

export const paymentService = new PaymentService();
