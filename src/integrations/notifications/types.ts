/**
 * Outbound message provider abstraction.
 *
 * Behind an interface for the same reasons payments are: the provider is a
 * configuration choice, and tests exercise the send paths without a network, an
 * API key, or the risk of actually emailing a real resident.
 *
 * Providers describe delivery, not policy. Whether a given resident should be
 * emailed at all is decided in the notification service, which owns channel
 * preferences and the rules that override them.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Always populated — it is the fallback and the SMS-adjacent form. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  replyTo?: string;
  /** Echoed back by the provider's webhooks, when it has them. */
  tags?: Record<string, string>;
}

export interface SmsMessage {
  /** E.164. Providers differ on leading `+`; each adapter normalises its own. */
  to: string;
  body: string;
}

/**
 * The outcome of one send.
 *
 * Never a thrown error for an ordinary delivery failure: the notification
 * service must be able to record "email failed, in-app record still stands"
 * without the failure escaping into whatever triggered the notification.
 */
export interface DeliveryResult {
  delivered: boolean;
  /** The provider's own message id, when it returns one. */
  providerMessageId?: string;
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<DeliveryResult>;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<DeliveryResult>;
}
