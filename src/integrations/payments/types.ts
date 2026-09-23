/**
 * Payment provider abstraction.
 *
 * Behind an interface so the provider is a configuration choice, and so tests
 * exercise the money paths without a network or live keys.
 *
 * All amounts are integer MINOR UNITS — kobo, not naira.
 */
export interface InitializePaymentInput {
  /** Our reference. The provider echoes it back on the webhook. */
  reference: string;
  amount: number;
  currency: string;
  email: string;
  callbackUrl?: string;
  /** Settles resident dues to the estate rather than the platform. */
  subaccountCode?: string;
  metadata?: Record<string, string | number>;
}

export interface InitializedPayment {
  /** Where to send the payer. */
  authorizationUrl: string;
  /** The provider's own reference. */
  providerReference: string;
}

export interface VerifiedPayment {
  /** True only when the provider says the money actually settled. */
  successful: boolean;
  reference: string;
  providerReference: string;
  amount: number;
  currency: string;
  /** Provider's cut, in minor units. */
  fee: number;
  method?: string;
  paidAt?: Date;
  failureReason?: string;
}

export interface WebhookVerification {
  valid: boolean;
  eventId: string;
  eventType: string;
  reference?: string;
}

export interface PaymentProvider {
  readonly name: string;

  initialize(input: InitializePaymentInput): Promise<InitializedPayment>;

  /**
   * Ask the provider whether a payment actually settled.
   *
   * The only source of truth. A browser returning to a success URL proves
   * nothing — that redirect is trivially forged, and trusting it would let
   * anyone mark their own dues paid.
   */
  verify(reference: string): Promise<VerifiedPayment>;

  /**
   * Check a webhook's signature against the RAW request body.
   *
   * Must be the raw bytes: re-serialising parsed JSON reorders keys and changes
   * whitespace, so the computed signature stops matching and every genuine
   * webhook is rejected.
   */
  verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification;

  refund(providerReference: string, amount?: number): Promise<{ accepted: boolean }>;
}
