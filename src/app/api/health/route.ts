import { NextResponse } from 'next/server';
import { connectToDatabase, isDatabaseConnected } from '@/core/db';

/**
 * Liveness and readiness probe.
 *
 * Deliberately outside the /api/v1 kernel: it must answer without
 * authentication, without rate limiting, and without depending on the machinery
 * it is reporting on. It exposes no version or build detail, which would only
 * help someone matching the deployment to a known vulnerability.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await connectToDatabase();
    const healthy = isDatabaseConnected();

    return NextResponse.json(
      { status: healthy ? 'ok' : 'degraded', database: healthy ? 'up' : 'down' },
      { status: healthy ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ status: 'degraded', database: 'down' }, { status: 503 });
  }
}
