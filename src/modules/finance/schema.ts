import mongoose, { Schema, type Model, type Types } from 'mongoose';
import type { TenantDocument } from '@/core/db';

/**
 * Fees, invoices and payments.
 *
 * All amounts are integer MINOR UNITS — kobo, not naira. Floating point money
 * accumulates rounding error that only becomes visible once the totals are
 * large enough for someone to notice, which is the worst time to find it.
 */

// ---------------------------------------------------------------------------
// Fee categories
// ---------------------------------------------------------------------------

export type BillingFrequency = 'monthly' | 'quarterly' | 'yearly' | 'one-time';

/**
 * What a fee is charged against.
 *
 * `property` bills each unit once regardless of how many people live there —
 * right for waste collection and security levies. `resident` bills each active
 * member — right for anything consumed per person.
 */
export type BillingBasis = 'property' | 'resident';

export interface FeeCategoryDoc extends TenantDocument {
  code: string;
  name: string;
  description?: string | null;

  /** Integer minor units. */
  amount: number;
  currency: string;

  frequency: BillingFrequency;
  basis: BillingBasis;

  /** Day of month invoices fall due. */
  dueDayOfMonth: number;
  /** Percent added per month once overdue. Zero disables penalties. */
  latePenaltyPercent: number;

  active: boolean;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const feeCategorySchema = new Schema<FeeCategoryDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    code: { type: String, required: true, lowercase: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 400, default: null },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'NGN' },

    frequency: {
      type: String,
      required: true,
      enum: ['monthly', 'quarterly', 'yearly', 'one-time'],
      default: 'monthly',
    },
    basis: { type: String, required: true, enum: ['property', 'resident'], default: 'property' },

    dueDayOfMonth: { type: Number, default: 1, min: 1, max: 28 },
    latePenaltyPercent: { type: Number, default: 0, min: 0, max: 100 },

    active: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

feeCategorySchema.index(
  { estateId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
feeCategorySchema.index({ estateId: 1, active: 1 });

export const FeeCategoryModel: Model<FeeCategoryDoc> =
  (mongoose.models.FeeCategory as Model<FeeCategoryDoc>) ??
  mongoose.model<FeeCategoryDoc>('FeeCategory', feeCategorySchema, 'fee_categories');

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  'draft' | 'issued' | 'partially-paid' | 'paid' | 'overdue' | 'cancelled' | 'written-off';

export interface InvoiceLine {
  feeCategoryId?: Types.ObjectId | null;
  description: string;
  quantity: number;
  /** Integer minor units, per unit of quantity. */
  unitAmount: number;
  /** quantity × unitAmount, stored so a later fee change cannot restate it. */
  lineTotal: number;
}

export interface InvoiceDoc extends TenantDocument {
  number: string;

  membershipId: Types.ObjectId;
  propertyId?: Types.ObjectId | null;

  lines: InvoiceLine[];

  subtotal: number;
  /** Late penalties accrued. Added to the total, tracked separately. */
  penaltyAmount: number;
  total: number;
  /** Sum of settled payments. Kept current so "outstanding" is one read. */
  amountPaid: number;
  currency: string;

  status: InvoiceStatus;

  /** Billing period this covers, for the resident's statement. */
  periodStart?: Date | null;
  periodEnd?: Date | null;

  issuedAt?: Date | null;
  dueAt: Date;
  paidAt?: Date | null;
  cancelledAt?: Date | null;
  cancellationReason?: string | null;

  notes?: string | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const invoiceLineSchema = new Schema<InvoiceLine>(
  {
    feeCategoryId: { type: Schema.Types.ObjectId, default: null, ref: 'FeeCategory' },
    description: { type: String, required: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    unitAmount: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    number: { type: String, required: true, uppercase: true, maxlength: 24 },

    membershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },
    propertyId: { type: Schema.Types.ObjectId, default: null, ref: 'Property' },

    lines: { type: [invoiceLineSchema], required: true },

    subtotal: { type: Number, required: true, min: 0 },
    penaltyAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    currency: { type: String, required: true, default: 'NGN' },

    status: {
      type: String,
      enum: ['draft', 'issued', 'partially-paid', 'paid', 'overdue', 'cancelled', 'written-off'],
      default: 'draft',
    },

    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    issuedAt: { type: Date, default: null },
    dueAt: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, maxlength: 500, default: null },

    notes: { type: String, maxlength: 1000, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

invoiceSchema.index(
  { estateId: 1, number: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
invoiceSchema.index({ estateId: 1, membershipId: 1, createdAt: -1 });
invoiceSchema.index({ estateId: 1, status: 1, dueAt: 1 });
invoiceSchema.index({ estateId: 1, propertyId: 1, status: 1 });

// One invoice per membership per fee period. Without this a billing run that
// retries after a partial failure charges everyone twice.
invoiceSchema.index(
  { estateId: 1, membershipId: 1, periodStart: 1, periodEnd: 1 },
  {
    unique: true,
    partialFilterExpression: { periodStart: { $type: 'date' }, deletedAt: null },
  },
);

export const InvoiceModel: Model<InvoiceDoc> =
  (mongoose.models.Invoice as Model<InvoiceDoc>) ??
  mongoose.model<InvoiceDoc>('Invoice', invoiceSchema);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'abandoned' | 'refunded';

export interface PaymentDoc extends TenantDocument {
  reference: string;

  invoiceId?: Types.ObjectId | null;
  membershipId: Types.ObjectId;

  amount: number;
  currency: string;

  provider: 'paystack' | 'manual';
  /** The provider's own reference, for reconciliation against their dashboard. */
  providerReference?: string | null;
  /** Card, bank transfer, USSD — whatever the provider reports. */
  method?: string | null;

  status: PaymentStatus;
  failureReason?: string | null;

  /** Provider fee, in minor units. Recorded so net revenue is knowable. */
  providerFee: number;

  /**
   * Set only by server-side verification or a signed webhook.
   *
   * A payment is never trusted because the browser came back to a success URL:
   * that redirect is trivially forged, and treating it as proof would let
   * anyone mark their own dues paid.
   */
  verifiedAt?: Date | null;
  verificationSource?: 'webhook' | 'api-verify' | 'manual' | null;

  paidAt?: Date | null;
  refundedAt?: Date | null;
  refundReason?: string | null;

  recordedBy?: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true },
    reference: { type: String, required: true, maxlength: 64 },

    invoiceId: { type: Schema.Types.ObjectId, default: null, ref: 'Invoice' },
    membershipId: { type: Schema.Types.ObjectId, required: true, ref: 'Membership' },

    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: 'NGN' },

    provider: { type: String, required: true, enum: ['paystack', 'manual'], default: 'paystack' },
    providerReference: { type: String, default: null },
    method: { type: String, default: null },

    status: {
      type: String,
      enum: ['pending', 'successful', 'failed', 'abandoned', 'refunded'],
      default: 'pending',
    },
    failureReason: { type: String, maxlength: 500, default: null },

    providerFee: { type: Number, default: 0, min: 0 },

    verifiedAt: { type: Date, default: null },
    verificationSource: {
      type: String,
      enum: ['webhook', 'api-verify', 'manual'],
      default: null,
    },

    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    refundReason: { type: String, maxlength: 500, default: null },

    recordedBy: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Our reference is unique platform-wide, not per estate: it is what Paystack
// echoes back on a webhook, at which point the estate is not yet known.
paymentSchema.index({ reference: 1 }, { unique: true });
paymentSchema.index(
  { providerReference: 1 },
  { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } } },
);
paymentSchema.index({ estateId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ estateId: 1, invoiceId: 1 });
paymentSchema.index({ estateId: 1, membershipId: 1, createdAt: -1 });

export const PaymentModel: Model<PaymentDoc> =
  (mongoose.models.Payment as Model<PaymentDoc>) ??
  mongoose.model<PaymentDoc>('Payment', paymentSchema);

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

/**
 * Every webhook received, recorded before it is acted on.
 *
 * Providers retry, and they retry precisely when something went wrong — so
 * duplicate delivery is the normal case, not the exceptional one. A unique
 * index on the provider's event id is what stops one payment being credited
 * twice.
 */
export interface WebhookEventDoc {
  _id: Types.ObjectId;
  provider: string;
  /** The provider's own event identifier. */
  eventId: string;
  eventType: string;
  signatureValid: boolean;
  processedAt?: Date | null;
  processingError?: string | null;
  createdAt: Date;
}

const webhookEventSchema = new Schema<WebhookEventDoc>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    signatureValid: { type: Boolean, required: true },
    processedAt: { type: Date, default: null },
    processingError: { type: String, maxlength: 1000, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: -1 });

export const WebhookEventModel: Model<WebhookEventDoc> =
  (mongoose.models.WebhookEvent as Model<WebhookEventDoc>) ??
  mongoose.model<WebhookEventDoc>('WebhookEvent', webhookEventSchema, 'webhook_events');
