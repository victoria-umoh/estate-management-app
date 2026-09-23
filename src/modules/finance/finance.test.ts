/**
 * Money.
 *
 * The properties under test are the ones that cost real money when wrong: the
 * ledger always balances, a payment is never credited twice, and nothing the
 * browser says is ever taken as proof that money moved.
 */
import mongoose from 'mongoose';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { events } from '@/core/events';
import { PERMISSIONS } from '@/core/rbac';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import { MockPaymentProvider, setPaymentProvider } from '@/integrations/payments';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { invoiceService } from './invoice.service';
import { ledgerService } from './ledger.service';
import { LedgerEntryModel } from './ledger.schema';
import { invoiceRepository, paymentService } from './payment.service';
import { InvoiceModel, PaymentModel, WebhookEventModel } from './schema';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();
const MEMBERSHIP = new mongoose.Types.ObjectId().toHexString();

function ctx(estateId = ESTATE_A, permissions: string[] = ['*']): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['finance-admin'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const admin = () => ctx();

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());
  setPaymentProvider(new MockPaymentProvider());
  await InvoiceModel.syncIndexes();
  await PaymentModel.syncIndexes();
  await WebhookEventModel.syncIndexes();
});

afterEach(() => {
  setCache(undefined);
  setPaymentProvider(undefined);
  events.removeAllHandlers();
});

/** ₦50,000 in kobo. Amounts are always integer minor units. */
const DUES = 5_000_000;

async function issuedInvoice(amount = DUES) {
  const invoice = await invoiceService.create(admin(), {
    membershipId: MEMBERSHIP,
    lines: [{ description: 'Monthly estate dues', unitAmount: amount }],
    dueAt: new Date(Date.now() + 14 * 86_400_000),
  });

  return invoiceService.issue(admin(), invoice._id.toHexString());
}

describe('the ledger', () => {
  it('posts a balanced transaction', async () => {
    const ref = await ledgerService.post(admin(), {
      description: 'Test',
      postings: [
        { account: 'cash', direction: 'debit', amount: 1000 },
        { account: 'revenue', direction: 'credit', amount: 1000 },
      ],
    });

    const entries = await LedgerEntryModel.find({ transactionRef: ref }).lean();
    expect(entries).toHaveLength(2);
  });

  // An unbalanced posting is a bug that would otherwise surface months later in
  // a reconciliation nobody can explain.
  it('refuses an unbalanced transaction', async () => {
    await expect(
      ledgerService.post(admin(), {
        description: 'Broken',
        postings: [
          { account: 'cash', direction: 'debit', amount: 1000 },
          { account: 'revenue', direction: 'credit', amount: 900 },
        ],
      }),
    ).rejects.toThrow(/Unbalanced/);

    expect(await LedgerEntryModel.countDocuments()).toBe(0);
  });

  it('refuses a single-sided or zero transaction', async () => {
    await expect(
      ledgerService.post(admin(), {
        description: 'One-sided',
        postings: [{ account: 'cash', direction: 'debit', amount: 1000 }],
      }),
    ).rejects.toThrow(/at least two postings/);

    await expect(
      ledgerService.post(admin(), {
        description: 'Zero',
        postings: [
          { account: 'cash', direction: 'debit', amount: 0 },
          { account: 'revenue', direction: 'credit', amount: 0 },
        ],
      }),
    ).rejects.toThrow(/cannot be for zero/);
  });

  // A fraction here means a division or conversion went unrounded upstream.
  it('refuses fractional minor units', async () => {
    await expect(
      ledgerService.post(admin(), {
        description: 'Fractional',
        postings: [
          { account: 'cash', direction: 'debit', amount: 100.5 },
          { account: 'revenue', direction: 'credit', amount: 100.5 },
        ],
      }),
    ).rejects.toThrow(/whole minor units/);
  });

  // A correction posts a reversal; it never edits history.
  it('is immutable', async () => {
    const ref = await ledgerService.post(admin(), {
      description: 'Test',
      postings: [
        { account: 'cash', direction: 'debit', amount: 1000 },
        { account: 'revenue', direction: 'credit', amount: 1000 },
      ],
    });

    const entry = await LedgerEntryModel.findOne({ transactionRef: ref }).lean();

    await expect(
      LedgerEntryModel.updateOne({ _id: entry!._id }, { $set: { amount: 1 } }),
    ).rejects.toThrow(/immutable/i);
    await expect(LedgerEntryModel.deleteOne({ _id: entry!._id })).rejects.toThrow(/immutable/i);
  });

  it('reverses a transaction by mirroring it', async () => {
    const ref = await ledgerService.post(admin(), {
      description: 'Original',
      postings: [
        { account: 'cash', direction: 'debit', amount: 1000 },
        { account: 'revenue', direction: 'credit', amount: 1000 },
      ],
    });

    await ledgerService.reverse(admin(), ref, 'Entered in error');

    // The original stands; the books net to nothing.
    expect(await LedgerEntryModel.countDocuments()).toBe(4);
    expect(await ledgerService.balance(admin(), 'cash')).toBe(0);

    const { balanced } = await ledgerService.verifyIntegrity(admin());
    expect(balanced).toBe(true);
  });

  it('applies normal balances, so revenue is not negative', async () => {
    await ledgerService.post(admin(), {
      description: 'Sale',
      postings: [
        { account: 'accounts-receivable', direction: 'debit', amount: 5000 },
        { account: 'revenue', direction: 'credit', amount: 5000 },
      ],
    });

    expect(await ledgerService.balance(admin(), 'accounts-receivable')).toBe(5000);
    expect(await ledgerService.balance(admin(), 'revenue')).toBe(5000);
  });

  it('keeps balances scoped to one estate', async () => {
    await ledgerService.post(admin(), {
      description: 'A',
      postings: [
        { account: 'cash', direction: 'debit', amount: 5000 },
        { account: 'revenue', direction: 'credit', amount: 5000 },
      ],
    });

    expect(await ledgerService.balance(ctx(ESTATE_B), 'cash')).toBe(0);
  });

  it('requires ledger.view to read balances', async () => {
    await expect(
      ledgerService.balance(ctx(ESTATE_A, [PERMISSIONS.INVOICE_VIEW]), 'cash'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('invoices', () => {
  it('creates as a draft with no accounting effect', async () => {
    const invoice = await invoiceService.create(admin(), {
      membershipId: MEMBERSHIP,
      lines: [{ description: 'Dues', unitAmount: DUES }],
      dueAt: new Date(Date.now() + 86_400_000),
    });

    expect(invoice.status).toBe('draft');
    expect(invoice.total).toBe(DUES);
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{5}$/);
    // A draft is not yet a debt.
    expect(await LedgerEntryModel.countDocuments()).toBe(0);
  });

  it('computes line totals and stores them', async () => {
    const invoice = await invoiceService.create(admin(), {
      membershipId: MEMBERSHIP,
      lines: [
        { description: 'Dues', unitAmount: 1_000_000, quantity: 3 },
        { description: 'Waste', unitAmount: 250_000 },
      ],
      dueAt: new Date(),
    });

    expect(invoice.lines[0]?.lineTotal).toBe(3_000_000);
    expect(invoice.total).toBe(3_250_000);
  });

  it('puts the debt on the books when issued', async () => {
    const invoice = await issuedInvoice();

    expect(invoice.status).toBe('issued');
    expect(await ledgerService.balance(admin(), 'accounts-receivable')).toBe(DUES);
    expect(await ledgerService.balance(admin(), 'revenue')).toBe(DUES);
  });

  it('refuses to issue twice', async () => {
    const invoice = await issuedInvoice();
    await expect(
      invoiceService.issue(admin(), invoice._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reverses the ledger when cancelled', async () => {
    const invoice = await issuedInvoice();
    await invoiceService.cancel(admin(), invoice._id.toHexString(), 'Billed in error');

    expect(await ledgerService.balance(admin(), 'accounts-receivable')).toBe(0);
    expect((await ledgerService.verifyIntegrity(admin())).balanced).toBe(true);
  });

  // Cancelling a paid invoice would erase the debt while the estate kept the
  // money.
  it('refuses to cancel an invoice with payments against it', async () => {
    const invoice = await issuedInvoice();
    await paymentService.recordManual(admin(), {
      invoiceId: invoice._id.toHexString(),
      membershipId: MEMBERSHIP,
      amount: DUES,
      note: 'Cash',
    });

    await expect(
      invoiceService.cancel(admin(), invoice._id.toHexString(), 'x'),
    ).rejects.toThrow(/Refund it instead/);
  });

  it('marks overdue invoices without moving the ledger', async () => {
    const invoice = await issuedInvoice();
    await InvoiceModel.updateOne(
      { _id: invoice._id },
      { $set: { dueAt: new Date(Date.now() - 86_400_000) } },
    );

    const before = await LedgerEntryModel.countDocuments();
    expect(await invoiceService.markOverdue(admin())).toBe(1);

    // Being late does not change what is owed.
    expect(await LedgerEntryModel.countDocuments()).toBe(before);
  });

  // Residents hold `invoice.view` so they can see their own dues. If that were
  // also what gated the estate-wide list, any resident could read every other
  // household's billing history — so the wide read has its own permission.
  it('refuses the estate-wide list to a resident-level permission', async () => {
    await issuedInvoice();

    await expect(
      invoiceService.list(ctx(ESTATE_A, [PERMISSIONS.INVOICE_VIEW]), {}),
    ).rejects.toMatchObject({ statusCode: 403 });

    const allowed = await invoiceService.list(
      ctx(ESTATE_A, [PERMISSIONS.INVOICE_VIEW_ALL]),
      {},
    );
    expect(allowed.items).toHaveLength(1);
  });

  // The resident-scoped read is the one a resident is allowed, and it is
  // narrowed by the caller resolving the membership from the session.
  it('lets a resident read only their own invoices', async () => {
    await issuedInvoice();
    const other = new mongoose.Types.ObjectId().toHexString();

    const resident = ctx(ESTATE_A, [PERMISSIONS.INVOICE_VIEW]);
    expect((await invoiceService.listForMember(resident, MEMBERSHIP)).items).toHaveLength(1);
    expect((await invoiceService.listForMember(resident, other)).items).toHaveLength(0);
  });

  it('refuses an invoice belonging to another membership', async () => {
    const invoice = await issuedInvoice();
    const other = new mongoose.Types.ObjectId().toHexString();

    await expect(
      invoiceService.assertBelongsTo(admin(), invoice._id.toHexString(), other),
      // A 404, not a 403: confirming the invoice exists but belongs to someone
      // else tells an attacker which ids are real.
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports what a resident owes', async () => {
    await issuedInvoice(1_000_000);
    await issuedInvoice(2_000_000);

    expect(await invoiceService.outstandingFor(admin(), MEMBERSHIP)).toBe(3_000_000);
  });
});

describe('payments', () => {
  it('settles a manual payment and clears the invoice', async () => {
    const invoice = await issuedInvoice();

    const payment = await paymentService.recordManual(admin(), {
      invoiceId: invoice._id.toHexString(),
      membershipId: MEMBERSHIP,
      amount: DUES,
      note: 'Bank transfer',
    });

    expect(payment.status).toBe('successful');
    expect(payment.verificationSource).toBe('manual');

    const settled = await invoiceRepository.findByIdOrFail(admin(), invoice._id);
    expect(settled.status).toBe('paid');
    expect(settled.amountPaid).toBe(DUES);

    // Cash up, receivable cleared, books balanced.
    expect(await ledgerService.balance(admin(), 'cash')).toBe(DUES);
    expect(await ledgerService.balance(admin(), 'accounts-receivable')).toBe(0);
    expect((await ledgerService.verifyIntegrity(admin())).balanced).toBe(true);
  });

  it('handles a part payment', async () => {
    const invoice = await issuedInvoice();

    await paymentService.recordManual(admin(), {
      invoiceId: invoice._id.toHexString(),
      membershipId: MEMBERSHIP,
      amount: 2_000_000,
      note: 'Part',
    });

    const partial = await invoiceRepository.findByIdOrFail(admin(), invoice._id);
    expect(partial.status).toBe('partially-paid');
    expect(await ledgerService.balance(admin(), 'accounts-receivable')).toBe(DUES - 2_000_000);
  });

  it('refuses to overpay', async () => {
    const invoice = await issuedInvoice();

    await expect(
      paymentService.recordManual(admin(), {
        invoiceId: invoice._id.toHexString(),
        membershipId: MEMBERSHIP,
        amount: DUES + 1,
        note: 'Too much',
      }),
    ).rejects.toThrow(/more than the amount outstanding/);
  });

  // Recording cash credits an account on nothing but a person's word.
  it('requires payment.verify to record a manual payment', async () => {
    const invoice = await issuedInvoice();

    await expect(
      paymentService.recordManual(ctx(ESTATE_A, [PERMISSIONS.PAYMENT_CREATE]), {
        invoiceId: invoice._id.toHexString(),
        membershipId: MEMBERSHIP,
        amount: 1000,
        note: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('emits a completion event', async () => {
    const handler = vi.fn();
    events.on('payment.completed', handler);

    const invoice = await issuedInvoice();
    await paymentService.recordManual(admin(), {
      invoiceId: invoice._id.toHexString(),
      membershipId: MEMBERSHIP,
      amount: DUES,
      note: 'Cash',
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  });

  it('records the settlement in the audit trail', async () => {
    const invoice = await issuedInvoice();
    await paymentService.recordManual(admin(), {
      invoiceId: invoice._id.toHexString(),
      membershipId: MEMBERSHIP,
      amount: DUES,
      note: 'Cash',
    });

    const actions = await AuditLogModel.find({ resource: 'payment' }).lean();
    expect(actions.map((entry) => entry.action).sort()).toEqual([
      'payment.recorded_manually',
      'payment.verified',
    ]);
  });
});

describe('webhooks', () => {
  const SECRET = 'mock-secret';

  function sign(body: string): string {
    return createHmac('sha512', SECRET).update(body, 'utf8').digest('hex');
  }

  function chargeSuccess(reference: string, id = 12345): string {
    return JSON.stringify({ event: 'charge.success', data: { id, reference, status: 'success' } });
  }

  async function pendingPayment(amount = DUES) {
    const invoice = await issuedInvoice(amount);

    const payment = await PaymentModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      reference: `EOS-TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      invoiceId: invoice._id,
      membershipId: new mongoose.Types.ObjectId(MEMBERSHIP),
      amount,
      currency: 'NGN',
      provider: 'paystack',
      status: 'pending',
      providerFee: 0,
    });

    return { invoice, payment };
  }

  // Anyone can POST to a webhook URL.
  it('rejects an unsigned webhook', async () => {
    const { payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);

    const result = await paymentService.handleWebhook(body, null);

    expect(result).toMatchObject({ accepted: false, reason: 'invalid-signature' });
    expect((await PaymentModel.findById(payment._id).lean())?.status).toBe('pending');
  });

  it('rejects a forged signature', async () => {
    const { payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);

    const result = await paymentService.handleWebhook(body, 'f'.repeat(128));
    expect(result.accepted).toBe(false);
  });

  // A signature covers the exact bytes; changing one invalidates it.
  it('rejects a tampered body', async () => {
    const { payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);
    const signature = sign(body);

    const tampered = chargeSuccess(payment.reference, 99999);
    expect((await paymentService.handleWebhook(tampered, signature)).accepted).toBe(false);
  });

  it('settles a payment on a valid webhook', async () => {
    const { invoice, payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);

    // The mock provider reports the amount it is asked about, so align it.
    setPaymentProvider({
      ...new MockPaymentProvider(),
      name: 'mock',
      initialize: new MockPaymentProvider().initialize,
      verify: async (reference: string) => ({
        successful: true,
        reference,
        providerReference: 'mock_ref',
        amount: DUES,
        currency: 'NGN',
        fee: 75_000,
        method: 'card',
        paidAt: new Date(),
      }),
      verifyWebhook: new MockPaymentProvider().verifyWebhook,
      refund: new MockPaymentProvider().refund,
    });

    const result = await paymentService.handleWebhook(body, sign(body));
    expect(result.accepted).toBe(true);

    const settled = await PaymentModel.findById(payment._id).lean();
    expect(settled?.status).toBe('successful');
    expect(settled?.verificationSource).toBe('webhook');

    const paidInvoice = await InvoiceModel.findById(invoice._id).lean();
    expect(paidInvoice?.status).toBe('paid');

    // The provider's fee is recorded, so net revenue is knowable.
    expect(await ledgerService.balance(admin(), 'cash')).toBe(DUES - 75_000);
    expect(await ledgerService.balance(admin(), 'payment-fees')).toBe(75_000);
    expect((await ledgerService.verifyIntegrity(admin())).balanced).toBe(true);
  });

  // Providers retry, especially when something went wrong.
  it('ignores a duplicate delivery', async () => {
    const { payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);
    const signature = sign(body);

    setPaymentProvider({
      name: 'mock',
      initialize: new MockPaymentProvider().initialize,
      verify: async (reference: string) => ({
        successful: true,
        reference,
        providerReference: 'mock_ref',
        amount: DUES,
        currency: 'NGN',
        fee: 0,
        paidAt: new Date(),
      }),
      verifyWebhook: new MockPaymentProvider().verifyWebhook,
      refund: new MockPaymentProvider().refund,
    });

    await paymentService.handleWebhook(body, signature);
    const second = await paymentService.handleWebhook(body, signature);

    expect(second).toMatchObject({ accepted: true, reason: 'duplicate' });

    // Credited exactly once.
    expect(await ledgerService.balance(admin(), 'cash')).toBe(DUES);
    expect(await LedgerEntryModel.countDocuments({ account: 'cash' })).toBe(1);
  });

  // The signature proves the message came from the provider; it does not prove
  // the body was not replayed from a smaller charge.
  it('does not settle when the verified amount disagrees', async () => {
    const { payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);

    setPaymentProvider({
      name: 'mock',
      initialize: new MockPaymentProvider().initialize,
      verify: async (reference: string) => ({
        successful: true,
        reference,
        providerReference: 'mock_ref',
        // Far less than the invoice.
        amount: 100,
        currency: 'NGN',
        fee: 0,
        paidAt: new Date(),
      }),
      verifyWebhook: new MockPaymentProvider().verifyWebhook,
      refund: new MockPaymentProvider().refund,
    });

    await paymentService.handleWebhook(body, sign(body));

    expect((await PaymentModel.findById(payment._id).lean())?.status).toBe('pending');
    expect(await ledgerService.balance(admin(), 'cash')).toBe(0);
  });

  it('accepts a webhook for an unknown payment without failing', async () => {
    const body = chargeSuccess('EOS-DOES-NOT-EXIST');
    expect(await paymentService.handleWebhook(body, sign(body))).toMatchObject({
      accepted: true,
      reason: 'unknown-payment',
    });
  });

  it('records every delivery it accepts', async () => {
    const { payment } = await pendingPayment();
    const body = chargeSuccess(payment.reference);

    await paymentService.handleWebhook(body, sign(body));
    expect(await WebhookEventModel.countDocuments()).toBe(1);
  });
});
