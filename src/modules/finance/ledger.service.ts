import { randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { BaseRepository } from '@/core/db';
import { InternalError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { LedgerEntryModel, type LedgerAccount, type LedgerEntryDoc } from './ledger.schema';

const log = createLogger('ledger');

class LedgerRepository extends BaseRepository<LedgerEntryDoc> {
  constructor() {
    super(LedgerEntryModel);
  }
}

const repository = new LedgerRepository();

export interface LedgerPosting {
  account: LedgerAccount;
  direction: 'debit' | 'credit';
  /** Integer minor units. */
  amount: number;
}

export interface PostTransactionInput {
  description: string;
  postings: LedgerPosting[];
  currency?: string;
  invoiceId?: string | Types.ObjectId;
  paymentId?: string | Types.ObjectId;
  membershipId?: string | Types.ObjectId;
  propertyId?: string | Types.ObjectId;
  occurredAt?: Date;
  session?: ClientSession;
}

export class LedgerService {
  /**
   * Post one balanced transaction.
   *
   * Debits must equal credits, checked here rather than trusted. An unbalanced
   * posting is a bug that would otherwise be discovered months later, during a
   * reconciliation nobody can now explain — and by then the wrong figure has
   * been reported to residents.
   *
   * The caller supplies a session for anything touching an invoice or payment,
   * so the ledger and the record it describes commit together. A payment marked
   * successful with no ledger entry is worse than a failed payment, because it
   * is silent.
   */
  async post(context: RequestContext, input: PostTransactionInput): Promise<string> {
    if (input.postings.length < 2) {
      throw new InternalError('A ledger transaction needs at least two postings.');
    }

    const debits = sum(input.postings, 'debit');
    const credits = sum(input.postings, 'credit');

    if (debits !== credits) {
      throw new InternalError(
        `Unbalanced ledger transaction: debits ${debits} != credits ${credits}.`,
      );
    }
    if (debits === 0) {
      throw new InternalError('A ledger transaction cannot be for zero.');
    }
    if (input.postings.some((posting) => !Number.isInteger(posting.amount))) {
      // Minor units are integers by definition; a fraction here means a
      // currency conversion or a division went unrounded somewhere upstream.
      throw new InternalError('Ledger amounts must be whole minor units.');
    }

    const transactionRef = randomUUID();
    const occurredAt = input.occurredAt ?? new Date();

    await repository.createMany(
      context,
      input.postings.map((posting) => ({
        transactionRef,
        account: posting.account,
        direction: posting.direction,
        amount: posting.amount,
        currency: input.currency ?? 'NGN',
        description: input.description,
        ...(input.invoiceId ? { invoiceId: new Types.ObjectId(input.invoiceId) } : {}),
        ...(input.paymentId ? { paymentId: new Types.ObjectId(input.paymentId) } : {}),
        ...(input.membershipId ? { membershipId: new Types.ObjectId(input.membershipId) } : {}),
        ...(input.propertyId ? { propertyId: new Types.ObjectId(input.propertyId) } : {}),
        occurredAt,
        recordedBy: new Types.ObjectId(context.userId),
      })),
      { ...(input.session ? { session: input.session } : {}) },
    );

    log.debug({ transactionRef, amount: debits }, 'ledger transaction posted');
    return transactionRef;
  }

  /**
   * Reverse a transaction by posting its mirror image.
   *
   * Corrections never edit history. The original stands, the reversal stands
   * beside it, and the books can be reconstructed as at any past date — which
   * is precisely what a dispute asks for.
   */
  async reverse(
    context: RequestContext,
    transactionRef: string,
    reason: string,
    session?: ClientSession,
  ): Promise<string> {
    assertCan(context, PERMISSIONS.PAYMENT_REFUND);

    const original = await repository.findMany(context, { transactionRef });
    if (original.length === 0) {
      throw new InternalError(`No ledger transaction found for ${transactionRef}.`);
    }

    return this.post(context, {
      description: `Reversal: ${reason}`,
      currency: original[0]!.currency,
      postings: original.map((entry) => ({
        account: entry.account,
        direction: entry.direction === 'debit' ? ('credit' as const) : ('debit' as const),
        amount: entry.amount,
      })),
      ...(original[0]!.invoiceId ? { invoiceId: original[0]!.invoiceId } : {}),
      ...(original[0]!.paymentId ? { paymentId: original[0]!.paymentId } : {}),
      ...(session ? { session } : {}),
    });
  }

  /**
   * Balance of one account.
   *
   * Sign convention follows normal balances: receivable and cash are debit
   * accounts, so debits increase them; revenue is a credit account, so credits
   * increase it. Returning a raw difference without that convention would make
   * revenue look negative, which is the sort of thing that gets "fixed" by
   * adding an abs() and hiding a real error.
   */
  async balance(context: RequestContext, account: LedgerAccount): Promise<number> {
    assertCan(context, PERMISSIONS.LEDGER_VIEW);

    const [result] = await repository.aggregate<{ debits: number; credits: number }>(context, [
      { $match: { account } },
      {
        $group: {
          _id: null,
          debits: {
            $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] },
          },
          credits: {
            $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] },
          },
        },
      },
    ]);

    if (!result) return 0;

    const isDebitAccount =
      account === 'accounts-receivable' ||
      account === 'cash' ||
      account === 'refunds' ||
      account === 'payment-fees';

    return isDebitAccount ? result.debits - result.credits : result.credits - result.debits;
  }

  /** Every account balance, for the finance dashboard. */
  async balances(context: RequestContext): Promise<Record<LedgerAccount, number>> {
    assertCan(context, PERMISSIONS.LEDGER_VIEW);

    const accounts: LedgerAccount[] = [
      'accounts-receivable',
      'cash',
      'revenue',
      'refunds',
      'payment-fees',
      'unapplied-credit',
    ];

    const entries = await Promise.all(
      accounts.map(async (account) => [account, await this.balance(context, account)] as const),
    );

    return Object.fromEntries(entries) as Record<LedgerAccount, number>;
  }

  /**
   * Confirm the books balance.
   *
   * Across the whole ledger, total debits must equal total credits. If they do
   * not, something has written entries outside `post()` — this is the check
   * that catches it, and it belongs on the finance dashboard rather than in a
   * runbook nobody opens.
   */
  async verifyIntegrity(
    context: RequestContext,
  ): Promise<{ balanced: boolean; debits: number; credits: number }> {
    assertCan(context, PERMISSIONS.LEDGER_VIEW);

    const [result] = await repository.aggregate<{ debits: number; credits: number }>(context, [
      {
        $group: {
          _id: null,
          debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } },
          credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } },
        },
      },
    ]);

    const debits = result?.debits ?? 0;
    const credits = result?.credits ?? 0;

    if (debits !== credits) {
      log.error({ debits, credits }, 'LEDGER OUT OF BALANCE');
    }

    return { balanced: debits === credits, debits, credits };
  }

  /** Statement for one resident, newest first. */
  async statementFor(
    context: RequestContext,
    membershipId: string,
    limit = 100,
  ): Promise<LedgerEntryDoc[]> {
    assertCan(context, PERMISSIONS.LEDGER_VIEW);

    const page = await repository.paginate(
      context,
      { membershipId: new Types.ObjectId(membershipId) },
      { limit },
      { sort: { occurredAt: -1 } },
    );

    return page.items;
  }
}

function sum(postings: LedgerPosting[], direction: 'debit' | 'credit'): number {
  return postings
    .filter((posting) => posting.direction === direction)
    .reduce((total, posting) => total + posting.amount, 0);
}

export const ledgerService = new LedgerService();
