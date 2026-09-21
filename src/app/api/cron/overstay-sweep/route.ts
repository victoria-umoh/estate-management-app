import { NextResponse } from 'next/server';
import { config } from '@/core/config';
import { connectToDatabase } from '@/core/db';
import { createLogger } from '@/core/logging';
import { runOverstaySweep } from '@/jobs/overstay-sweep';

const log = createLogger('cron:overstay');

/**
 * Scheduled overstay sweep, for deployments running jobs as HTTP cron.
 *
 * Deliberately outside the /api/v1 kernel: it is not a user-facing API, has no
 * session, and authenticates with a shared secret instead. Without that secret
 * anyone who found the URL could run the sweep at will.
 *
 * The comparison is length-safe rather than a plain `===`, since the header is
 * attacker-supplied.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = config.queue.cronSecret;

  if (!expected) {
    log.error('overstay cron route called but CRON_SECRET is not configured');
    return NextResponse.json({ error: 'Not configured.' }, { status: 503 });
  }

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  const { timingSafeEqual } = await import('node:crypto');

  const authorised =
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer);

  if (!authorised) {
    log.warn('rejected unauthorised overstay sweep request');
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 });
  }

  try {
    await connectToDatabase();
    const result = await runOverstaySweep();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    log.error({ err: error }, 'overstay sweep failed');
    return NextResponse.json({ error: 'Sweep failed.' }, { status: 500 });
  }
}
