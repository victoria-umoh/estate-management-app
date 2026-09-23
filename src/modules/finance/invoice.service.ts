import { Types } from 'mongoose';
import { allocateReference, withTransaction } from '@/core/db';
import { events } from '@/core/events';
import { ConflictError, NotFoundError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { membershipRepository } from '@/modules/membership/repository';
import { ledgerService } from './ledger.service';
import { invoiceRepository } from './payment.service';
import { InvoiceModel, type InvoiceDoc, type InvoiceLine } from './schema';

const log = createLogger('invoice');

export interface CreateInvoiceInput {
  membershipId: string;
  propertyId?: string;
  lines: Array<{
    feeCategoryId?: string;
    description: string;
    quantity?: number;
    /** Integer minor units. */
    unitAmount: number;
  }>;
  dueAt: Date;
  periodStart?: Date;
  periodEnd?: Date;
  notes?: string;
  currency?: string;
}

export class InvoiceService {
  /**
   * Create an invoice as a draft.
   *
   * Drafts have no accounting effect. Issuing is the separate act that puts a
   * debt on the books, which means a mistake caught before issue costs nothing
   * — and once issued, the entry stands and is corrected by a credit note
   * rather than by editing.
   */
  async create(context: RequestContext, input: CreateInvoiceInput): Promise<InvoiceDoc> {
    assertCan(context, PERMISSIONS.INVOICE_CREATE);

    if (input.lines.length === 0) {
      throw new UnprocessableError('An invoice needs at least one line.');
    }

    const lines: InvoiceLine[] = input.lines.map((line) => {
      const quantity = line.quantity ?? 1;

      if (!Number.isInteger(line.unitAmount) || line.unitAmount < 0) {
        throw new UnprocessableError('Amounts must be whole minor units.');
      }

      return {
        feeCategoryId: line.feeCategoryId ? new Types.ObjectId(line.feeCategoryId) : null,
        description: line.description,
        quantity,
        unitAmount: line.unitAmount,
        // Computed once and stored. Recomputing from the fee category later
        // would restate historical invoices whenever a fee changes.
        lineTotal: quantity * line.unitAmount,
      };
    });

    const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);

    return invoiceRepository.create(context, {
      number: await allocateReference(InvoiceModel, 'number', 'INV', context.estateId),
      membershipId: new Types.ObjectId(input.membershipId),
      ...(input.propertyId ? { propertyId: new Types.ObjectId(input.propertyId) } : {}),
      lines,
      subtotal,
      penaltyAmount: 0,
      total: subtotal,
      amountPaid: 0,
      currency: input.currency ?? 'NGN',
      status: 'draft',
      dueAt: input.dueAt,
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
  }

  /**
   * Issue an invoice, putting the debt on the books.
   *
   * The ledger entry and the status change commit together: an invoice a
   * resident can see but the ledger does not know about is how a collection
   * total quietly stops matching what was actually billed.
   */
  async issue(context: RequestContext, invoiceId: string): Promise<InvoiceDoc> {
    assertCan(context, PERMISSIONS.INVOICE_CREATE);

    const invoice = await invoiceRepository.findByIdOrFail(context, invoiceId);

    if (invoice.status !== 'draft') {
      throw new ConflictError(`That invoice is already ${invoice.status}.`);
    }

    return withTransaction(async (session) => {
      const issued = await invoiceRepository.updateById(
        context,
        invoiceId,
        { $set: { status: 'issued', issuedAt: new Date() } },
        { session },
      );

      // The resident now owes; the estate has earned.
      await ledgerService.post(context, {
        description: `Invoice ${invoice.number}`,
        currency: invoice.currency,
        postings: [
          { account: 'accounts-receivable', direction: 'debit', amount: invoice.total },
          { account: 'revenue', direction: 'credit', amount: invoice.total },
        ],
        invoiceId: invoice._id,
        membershipId: invoice.membershipId,
        ...(invoice.propertyId ? { propertyId: invoice.propertyId } : {}),
        session,
      });

      await auditService.record(context, {
        action: 'invoice.issued',
        resource: 'invoice',
        resourceId: invoiceId,
        metadata: { number: invoice.number, total: invoice.total },
        session,
      });

      events.emit('invoice.issued', {
        invoiceId,
        estateId: context.estateId,
        amount: invoice.total,
      });

      return issued;
    });
  }

  /**
   * Cancel an invoice, reversing its ledger effect.
   *
   * Only before payment. Once money has changed hands the correction is a
   * refund, which returns the money as well as the entry — cancelling would
   * erase the debt while the estate kept the cash.
   */
  async cancel(context: RequestContext, invoiceId: string, reason: string): Promise<InvoiceDoc> {
    assertCan(context, PERMISSIONS.INVOICE_CANCEL);

    const invoice = await invoiceRepository.findByIdOrFail(context, invoiceId);

    if (invoice.amountPaid > 0) {
      throw new ConflictError('That invoice has payments against it. Refund it instead.');
    }
    if (invoice.status === 'cancelled') {
      throw new ConflictError('That invoice is already cancelled.');
    }

    return withTransaction(async (session) => {
      const cancelled = await invoiceRepository.updateById(
        context,
        invoiceId,
        {
          $set: { status: 'cancelled', cancelledAt: new Date(), cancellationReason: reason },
        },
        { session },
      );

      // Only an issued invoice reached the ledger, so only that needs undoing.
      if (invoice.status !== 'draft') {
        await ledgerService.post(context, {
          description: `Cancelled invoice ${invoice.number}`,
          currency: invoice.currency,
          postings: [
            { account: 'revenue', direction: 'debit', amount: invoice.total },
            { account: 'accounts-receivable', direction: 'credit', amount: invoice.total },
          ],
          invoiceId: invoice._id,
          membershipId: invoice.membershipId,
          session,
        });
      }

      await auditService.record(context, {
        action: 'invoice.cancelled',
        resource: 'invoice',
        resourceId: invoiceId,
        metadata: { number: invoice.number, reason },
        session,
      });

      return cancelled;
    });
  }

  /**
   * Mark issued invoices past their due date as overdue.
   *
   * Status only — no ledger movement, because being late does not change what
   * is owed. Penalties, if an estate charges them, are a separate posting.
   */
  async markOverdue(context: RequestContext): Promise<number> {
    const count = await invoiceRepository.updateMany(
      context,
      {
        status: { $in: ['issued', 'partially-paid'] },
        dueAt: { $lt: new Date() },
      },
      { $set: { status: 'overdue' } },
    );

    if (count > 0) log.info({ count }, 'invoices marked overdue');
    return count;
  }

  /**
   * List invoices, newest first.
   *
   * A resident seeing only their own invoices is enforced by the caller passing
   * their own membership id; the permission split is `invoice.view` for the
   * whole estate versus the resident-scoped portal route.
   */
  async list(
    context: RequestContext,
    filters: { status?: InvoiceDoc['status']; membershipId?: string; propertyId?: string },
    pagination: { page?: number; limit?: number } = {},
  ) {
    assertCan(context, PERMISSIONS.INVOICE_VIEW_ALL);

    return invoiceRepository.paginate(
      context,
      {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.membershipId
          ? { membershipId: new Types.ObjectId(filters.membershipId) }
          : {}),
        ...(filters.propertyId ? { propertyId: new Types.ObjectId(filters.propertyId) } : {}),
      },
      pagination,
      { sort: { createdAt: -1 } },
    );
  }

  /**
   * The caller's own membership.
   *
   * Resolved from the session rather than accepted from the request, so a
   * resident-facing route cannot be pointed at another household by changing
   * one value in the browser.
   */
  async callerMembershipId(context: RequestContext): Promise<string> {
    const membership = await membershipRepository.findOne(context, { userId: context.userId });
    if (!membership) throw new NotFoundError('Membership');

    return membership._id.toHexString();
  }

  /** The caller's own invoices. Needs no estate-wide permission. */
  async listForCaller(
    context: RequestContext,
    pagination: { page?: number; limit?: number } = {},
  ) {
    return this.listForMember(context, await this.callerMembershipId(context), pagination);
  }

  /**
   * A single membership's invoices, with no estate-wide permission required.
   *
   * The caller is responsible for having resolved the membership from the
   * session rather than from the request — this method trusts the id it is
   * given, which is why the route above it never takes one from the client.
   */
  async listForMember(
    context: RequestContext,
    membershipId: string,
    pagination: { page?: number; limit?: number } = {},
  ) {
    return invoiceRepository.paginate(
      context,
      { membershipId: new Types.ObjectId(membershipId) },
      pagination,
      { sort: { createdAt: -1 } },
    );
  }

  /**
   * Confirm an invoice belongs to a membership.
   *
   * A 404 rather than a 403 on mismatch: confirming an invoice exists but
   * belongs to someone else tells an attacker which ids are real.
   */
  async assertBelongsTo(
    context: RequestContext,
    invoiceId: string,
    membershipId: string,
  ): Promise<InvoiceDoc> {
    const invoice = await invoiceRepository.findOne(context, {
      _id: new Types.ObjectId(invoiceId),
      membershipId: new Types.ObjectId(membershipId),
    });

    if (!invoice) throw new NotFoundError('Invoice');
    return invoice;
  }

  /** What a resident currently owes across every unpaid invoice. */
  async outstandingFor(context: RequestContext, membershipId: string): Promise<number> {
    // Takes an arbitrary membership id, so it is an estate-wide read even when
    // the caller happens to pass their own.
    assertCan(context, PERMISSIONS.INVOICE_VIEW_ALL);

    const invoices = await invoiceRepository.findMany(context, {
      membershipId: new Types.ObjectId(membershipId),
      status: { $in: ['issued', 'partially-paid', 'overdue'] },
    });

    return invoices.reduce((total, invoice) => total + (invoice.total - invoice.amountPaid), 0);
  }
}

export const invoiceService = new InvoiceService();
