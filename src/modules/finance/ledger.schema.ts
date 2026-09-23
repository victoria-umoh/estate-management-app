import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * Double-entry ledger.
 *
 * Every movement of money is written as balanced debit and credit entries
 * sharing one `transactionRef`. Single-entry bookkeeping would be simpler and
 * would also make "the numbers do not add up" unanswerable: with double entry,
 * a discrepancy is locatable rather than merely detectable.
 *
 * Append-only. An amount that can be edited after the fact is not a ledger, and
 * the collection is the record an estate answers to its residents with.
 *
 * Amounts are integer MINOR UNITS — kobo, not naira. Floating point money is a
 * recurring source of rounding error that only shows up once the totals are
 * large enough to matter.
 */
export type LedgerAccount =
  /** Owed by residents. Debited when an invoice is issued. */
  | 'accounts-receivable'
  /** Money actually held. Debited when a payment settles. */
  | 'cash'
  /** Income earned. Credited when an invoice is issued. */
  | 'revenue'
  /** Money returned to a resident. */
  | 'refunds'
  /** Fees taken by the payment provider. */
  | 'payment-fees'
  /** Received without a matching invoice; held until reconciled. */
  | 'unapplied-credit';

export type LedgerDirection = 'debit' | 'credit';

export interface LedgerEntryDoc extends TenantDocument {
  /** Shared by every entry in one balanced transaction. */
  transactionRef: string;

  account: LedgerAccount;
  direction: LedgerDirection;
  /** Integer minor units. Always positive; direction carries the sign. */
  amount: number;
  currency: string;

  description: string;

  invoiceId?: Types.ObjectId | null;
  paymentId?: Types.ObjectId | null;
  membershipId?: Types.ObjectId | null;
  propertyId?: Types.ObjectId | null;

  occurredAt: Date;
  recordedBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const ledgerEntrySchema = new Schema<LedgerEntryDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    transactionRef: { type: String, required: true },

    account: {
      type: String,
      required: true,
      enum: [
        'accounts-receivable',
        'cash',
        'revenue',
        'refunds',
        'payment-fees',
        'unapplied-credit',
      ],
    },
    direction: { type: String, required: true, enum: ['debit', 'credit'] },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'NGN' },

    description: { type: String, required: true, maxlength: 200 },

    invoiceId: { type: Schema.Types.ObjectId, default: null, ref: 'Invoice' },
    paymentId: { type: Schema.Types.ObjectId, default: null, ref: 'Payment' },
    membershipId: { type: Schema.Types.ObjectId, default: null, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    occurredAt: { type: Date, required: true, default: Date.now },
    recordedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * Reject modification at the ODM layer.
 *
 * A correction is made by posting a reversing entry, never by editing history.
 * That is not ceremony: it is what lets someone reconstruct what the books said
 * on any past date, which is exactly what a dispute asks for.
 */
for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
] as const) {
  ledgerEntrySchema.pre(operation, function blockMutation() {
    throw new Error(
      `Ledger entries are immutable: "${operation}" is not permitted. Post a reversing entry instead.`,
    );
  });
}

ledgerEntrySchema.index({ estateId: 1, occurredAt: -1 });
ledgerEntrySchema.index({ estateId: 1, transactionRef: 1 });
ledgerEntrySchema.index({ estateId: 1, account: 1, occurredAt: -1 });
ledgerEntrySchema.index({ estateId: 1, invoiceId: 1 });
ledgerEntrySchema.index({ estateId: 1, membershipId: 1, occurredAt: -1 });

export const LedgerEntryModel: Model<LedgerEntryDoc> =
  (mongoose.models.LedgerEntry as Model<LedgerEntryDoc>) ??
  mongoose.model<LedgerEntryDoc>('LedgerEntry', ledgerEntrySchema, 'ledger_entries');
