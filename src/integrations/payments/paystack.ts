import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@/core/config';
import { UpstreamError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import type {
  InitializePaymentInput,
  InitializedPayment,
  PaymentProvider,
  VerifiedPayment,
  WebhookVerification,
} from './types';

const log = createLogger('paystack');

const BASE_URL = 'https://api.paystack.co';

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackTransaction {
  id: number;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  fees: number | null;
  paid_at: string | null;
  gateway_response: string | null;
  channel: string | null;
}

export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<PaystackEnvelope<T>> {
    let response: Response;

    try {
      response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${config.payments.paystack.secretKey}`,
          'content-type': 'application/json',
          ...init.headers,
        },
        // Bounded, so a hanging provider cannot hold a checkout request open.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // The message is deliberately vague to the caller; the detail goes to the
      // log, because a payment error surfaced to a resident should not contain
      // a provider's internals.
      log.error({ err: error, path }, 'paystack request failed');
      throw new UpstreamError('payment provider', error);
    }

    const body = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;

    if (!response.ok || !body?.status) {
      log.error({ path, status: response.status, message: body?.message }, 'paystack error');
      throw new UpstreamError('payment provider');
    }

    return body;
  }

  async initialize(input: InitializePaymentInput): Promise<InitializedPayment> {
    const body = await this.request<{ authorization_url: string; reference: string }>(
      '/transaction/initialize',
      {
        method: 'POST',
        body: JSON.stringify({
          reference: input.reference,
          amount: input.amount,
          currency: input.currency,
          email: input.email,
          ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
          // Routes resident dues to the estate's own subaccount rather than
          // the platform account.
          ...(input.subaccountCode ? { subaccount: input.subaccountCode } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }),
      },
    );

    return {
      authorizationUrl: body.data.authorization_url,
      providerReference: body.data.reference,
    };
  }

  async verify(reference: string): Promise<VerifiedPayment> {
    const body = await this.request<PaystackTransaction>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    const transaction = body.data;

    return {
      // Only "success" counts. Paystack also reports ongoing, pending and
      // abandoned, none of which mean money has moved.
      successful: transaction.status === 'success',
      reference: transaction.reference,
      providerReference: String(transaction.id),
      amount: transaction.amount,
      currency: transaction.currency,
      fee: transaction.fees ?? 0,
      ...(transaction.channel ? { method: transaction.channel } : {}),
      ...(transaction.paid_at ? { paidAt: new Date(transaction.paid_at) } : {}),
      ...(transaction.status !== 'success' && transaction.gateway_response
        ? { failureReason: transaction.gateway_response }
        : {}),
    };
  }

  /**
   * Verify a webhook signature.
   *
   * Paystack signs the raw request body with HMAC-SHA512 using the secret key.
   * The comparison is constant-time: a fast `===` leaks, through timing, how
   * much of a forged signature was correct, which is enough to construct a
   * valid one given patience.
   */
  verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification {
    const secret = config.payments.paystack.webhookSecret;

    if (!secret || !signatureHeader) {
      return { valid: false, eventId: '', eventType: 'unknown' };
    }

    const expected = createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');

    const supplied = Buffer.from(signatureHeader, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    const valid =
      supplied.length === computed.length && timingSafeEqual(supplied, computed);

    if (!valid) {
      log.warn('rejected webhook with an invalid signature');
      return { valid: false, eventId: '', eventType: 'unknown' };
    }

    // Parsed only after the signature checks out, so untrusted input never
    // reaches JSON.parse.
    let payload: { event?: string; data?: { id?: number; reference?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { valid: false, eventId: '', eventType: 'unknown' };
    }

    return {
      valid: true,
      // Paystack sends no dedicated event id, so the transaction id plus the
      // event type identifies a delivery — which is what the idempotency index
      // needs.
      eventId: `${payload.data?.id ?? 'unknown'}:${payload.event ?? 'unknown'}`,
      eventType: payload.event ?? 'unknown',
      ...(payload.data?.reference ? { reference: payload.data.reference } : {}),
    };
  }

  async refund(providerReference: string, amount?: number): Promise<{ accepted: boolean }> {
    await this.request('/refund', {
      method: 'POST',
      body: JSON.stringify({
        transaction: providerReference,
        ...(amount ? { amount } : {}),
      }),
    });

    return { accepted: true };
  }
}
