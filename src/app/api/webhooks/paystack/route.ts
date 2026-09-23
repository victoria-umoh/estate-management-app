import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/core/db';
import { createLogger } from '@/core/logging';
import { paymentService } from '@/modules/finance';

const log = createLogger('webhook:paystack');

/**
 * Paystack webhook.
 *
 * Deliberately outside the /api/v1 kernel. It has no session, belongs to no
 * estate until the reference is resolved, and must read the request body as raw
 * text — the signature covers exact bytes, and anything that parses and
 * re-serialises the JSON first will produce a different string and reject every
 * genuine delivery.
 *
 * The route is a thin shell on purpose: signature verification, idempotency and
 * re-verification against the provider API all live in the service, where they
 * are tested.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  try {
    await connectToDatabase();
    const result = await paymentService.handleWebhook(rawBody, signature);

    if (!result.accepted) {
      // 401 rather than 400: the delivery was not from Paystack, and nothing
      // about our state should be inferable from the response.
      return NextResponse.json({ error: 'Rejected.' }, { status: 401 });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    // A 500 makes Paystack retry, which is what we want — the alternative is
    // acknowledging a payment we failed to record.
    log.error({ err: error }, 'paystack webhook handling failed');
    return NextResponse.json({ error: 'Processing failed.' }, { status: 500 });
  }
}
