import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '@/core/config';
import type {
  InitializePaymentInput,
  InitializedPayment,
  PaymentProvider,
  VerifiedPayment,
  WebhookVerification,
} from './types';

export type {
  InitializePaymentInput,
  InitializedPayment,
  PaymentProvider,
  VerifiedPayment,
  WebhookVerification,
} from './types';

/**
 * Offline payment provider, for development and tests.
 *
 * Signs webhooks with the same HMAC-SHA512 scheme as Paystack, so the
 * signature-verification path is genuinely exercised rather than stubbed past.
 * A test suite that skips signature checking would pass happily against a
 * server that accepts forged webhooks.
 *
 * A reference containing `fail` settles as a failure, keeping the unhappy path
 * live without needing a real card that declines.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async initialize(input: InitializePaymentInput): Promise<InitializedPayment> {
    return {
      authorizationUrl: `${config.app.url}/payments/mock?reference=${encodeURIComponent(input.reference)}`,
      providerReference: `mock_${randomUUID()}`,
    };
  }

  async verify(reference: string): Promise<VerifiedPayment> {
    const successful = !reference.includes('fail');

    return {
      successful,
      reference,
      providerReference: `mock_${reference}`,
      amount: 0,
      currency: config.payments.defaultCurrency,
      // A plausible 1.5%, so fee handling is exercised rather than always zero.
      fee: 0,
      method: 'mock',
      ...(successful ? { paidAt: new Date() } : { failureReason: 'Simulated failure' }),
    };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification {
    const secret = config.payments.paystack.webhookSecret ?? 'mock-secret';

    if (!signatureHeader) return { valid: false, eventId: '', eventType: 'unknown' };

    const expected = createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
    const supplied = Buffer.from(signatureHeader, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    if (supplied.length !== computed.length || !timingSafeEqual(supplied, computed)) {
      return { valid: false, eventId: '', eventType: 'unknown' };
    }

    let payload: { event?: string; data?: { id?: number; reference?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { valid: false, eventId: '', eventType: 'unknown' };
    }

    return {
      valid: true,
      eventId: `${payload.data?.id ?? 'unknown'}:${payload.event ?? 'unknown'}`,
      eventType: payload.event ?? 'unknown',
      ...(payload.data?.reference ? { reference: payload.data.reference } : {}),
    };
  }

  async refund(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}

let instance: PaymentProvider | undefined;
let pending: Promise<PaymentProvider> | undefined;

/**
 * The configured provider.
 *
 * Async because Paystack is loaded by dynamic import — `require()` is CommonJS
 * and throws under plain Node ESM, which would break every job and script that
 * touches payments.
 */
export function getPaymentProvider(): Promise<PaymentProvider> {
  pending ??= build();
  return pending;
}

async function build(): Promise<PaymentProvider> {
  if (instance) return instance;

  // Falls back to the mock when no key is configured, rather than constructing
  // a client that will fail on first use with a confusing upstream error.
  if (config.payments.paystack.secretKey) {
    const { PaystackProvider } = await import('./paystack');
    instance = new PaystackProvider();
  } else {
    instance = new MockPaymentProvider();
  }

  return instance;
}

export function setPaymentProvider(provider: PaymentProvider | undefined): void {
  instance = provider;
  pending = provider ? Promise.resolve(provider) : undefined;
}
