/**
 * Invoice and payment exports.
 *
 * The properties that matter: the export permission is a real gate and not
 * decoration, a refusal is recorded rather than swallowed, the file is written
 * by the one CSV writer that gets Excel right, and no resident's name, phone
 * number or address is in it.
 */
import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { InvoiceModel, PaymentModel } from './schema';
import { financeExportService, resolveExportRange } from './export.service';

setupTestDatabase();

const estateId = new Types.ObjectId().toHexString();

function ctx(permissions: string[]): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-manager'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const FULL_INVOICE = [PERMISSIONS.INVOICE_VIEW_ALL, PERMISSIONS.INVOICE_EXPORT];
const FULL_PAYMENT = [PERMISSIONS.PAYMENT_VIEW, PERMISSIONS.PAYMENT_EXPORT];

const range = () => resolveExportRange({});

async function seedInvoice(overrides: Record<string, unknown> = {}) {
  return InvoiceModel.create({
    estateId: new Types.ObjectId(estateId),
    number: `INV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    membershipId: new Types.ObjectId(),
    lines: [{ description: 'Monthly dues', quantity: 1, unitAmount: 500_000, lineTotal: 500_000 }],
    subtotal: 500_000,
    penaltyAmount: 0,
    total: 500_000,
    amountPaid: 0,
    currency: 'NGN',
    status: 'issued',
    issuedAt: new Date(),
    dueAt: new Date(Date.now() + 7 * 86_400_000),
    ...overrides,
  });
}

async function seedPayment(overrides: Record<string, unknown> = {}) {
  return PaymentModel.create({
    estateId: new Types.ObjectId(estateId),
    reference: `EOS-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    membershipId: new Types.ObjectId(),
    amount: 500_000,
    currency: 'NGN',
    provider: 'manual',
    status: 'successful',
    providerFee: 1_500,
    verificationSource: 'manual',
    paidAt: new Date(),
    ...overrides,
  });
}

describe('the export permission is a real gate', () => {
  it('refuses an invoice export from a caller with view but not export', async () => {
    await seedInvoice();

    await expect(
      financeExportService.invoices(ctx([PERMISSIONS.INVOICE_VIEW_ALL]), range()),
    ).rejects.toThrow(/invoice\.export/);
  });

  it('refuses a payment export from a caller with view but not export', async () => {
    await seedPayment();

    await expect(
      financeExportService.payments(ctx([PERMISSIONS.PAYMENT_VIEW]), range()),
    ).rejects.toThrow(/payment\.export/);
  });

  it('refuses an export from a caller with export but not view', async () => {
    // Export is an additional act, not a substitute for being allowed to see
    // the thing at all.
    await expect(
      financeExportService.invoices(ctx([PERMISSIONS.INVOICE_EXPORT]), range()),
    ).rejects.toThrow(/invoice\.viewAll/);
  });

  it('records the refusal before throwing', async () => {
    const context = ctx([PERMISSIONS.INVOICE_VIEW_ALL]);

    await expect(financeExportService.invoices(context, range())).rejects.toThrow();

    const denied = await AuditLogModel.findOne({ action: 'invoice.export.denied' }).lean();
    expect(denied).toBeTruthy();
    expect(denied!.outcome).toBe('failure');
    expect(denied!.reason).toContain('invoice.export');
  });
});

describe('the invoice export itself', () => {
  it('writes a spreadsheet Excel can open, and audits the act', async () => {
    await seedInvoice();
    const context = ctx(FULL_INVOICE);

    const file = await financeExportService.invoices(context, range());

    // A UTF-8 BOM and CRLF line endings, which is what `report/csv` guarantees
    // and what Excel on Windows needs to render a name correctly.
    expect(file.body.startsWith('﻿')).toBe(true);
    expect(file.body).toContain('\r\n');
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.filename).toMatch(/^invoices-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.rowCount).toBe(1);

    // Money comes out in major units with two decimals, so the column sums in
    // the spreadsheet rather than being a hundred times too large.
    expect(file.body).toContain('5000.00');
    expect(file.body).toContain('Total (NGN)');

    const exported = await AuditLogModel.findOne({ action: 'invoice.exported' }).lean();
    expect(exported!.metadata!.rows).toBe(1);
  });

  it('neutralises a cell Excel would run as a formula', async () => {
    // A resident whose reference begins with `=` becomes a live formula in
    // whoever opens the file, unless the writer guards it.
    // The schema upper-cases invoice numbers, hence the comparison below.
    await seedInvoice({ number: '=CMD|ping' });

    const file = await financeExportService.invoices(ctx(FULL_INVOICE), range());

    expect(file.body).toContain("'=CMD|PING");
    expect(file.body).not.toMatch(/(^|,)=CMD/m);
  });

  it('carries no identity fields', async () => {
    await seedInvoice();

    const file = await financeExportService.invoices(ctx(FULL_INVOICE), range());
    const header = file.body.split('\r\n').find((line) => line.startsWith('Invoice,'));

    expect(header).toBeTruthy();
    for (const forbidden of ['Name', 'Email', 'Phone', 'NIN', 'Address']) {
      expect(header).not.toContain(forbidden);
    }
  });

  it('refuses a range wider than a year', async () => {
    await expect(
      financeExportService.invoices(ctx(FULL_INVOICE), {
        from: new Date('2020-01-01'),
        to: new Date('2026-01-01'),
      }),
    ).rejects.toThrow(/at most 366 days/);
  });

  it('refuses a range that runs backwards', async () => {
    await expect(
      financeExportService.invoices(ctx(FULL_INVOICE), {
        from: new Date('2026-02-01'),
        to: new Date('2026-01-01'),
      }),
    ).rejects.toThrow(/falls before its start/);
  });

  it('cannot see another estate’s billing', async () => {
    await seedInvoice();

    const stranger: RequestContext = {
      ...ctx(FULL_INVOICE),
      estateId: new Types.ObjectId().toHexString(),
    };

    const file = await financeExportService.invoices(stranger, range());
    expect(file.rowCount).toBe(0);
  });
});

describe('the payment export', () => {
  it('reports the provider fee and the net, and how the money was confirmed', async () => {
    await seedPayment();

    const file = await financeExportService.payments(ctx(FULL_PAYMENT), range());

    expect(file.rowCount).toBe(1);
    expect(file.body).toContain('Provider fee (NGN)');
    // 500000 - 1500 minor units, in major units.
    expect(file.body).toContain('4985.00');
    expect(file.body).toContain('Verified by');
  });

  it('includes a payment that never settled', async () => {
    // A pending payment has no `paidAt`. Dropping it would make the failure
    // rate invisible, which is the one figure a reconciliation is for.
    await seedPayment({ status: 'failed', paidAt: null, verificationSource: null });

    const file = await financeExportService.payments(ctx(FULL_PAYMENT), range());
    expect(file.rowCount).toBe(1);
    expect(file.body).toContain('failed');
  });
});
