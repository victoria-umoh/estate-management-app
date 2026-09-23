/**
 * Next.js instrumentation hook.
 *
 * Runs once per runtime before any request is served. Both Sentry and New Relic
 * are opt-in via environment: with no DSN and no licence key, this does nothing
 * and makes no network calls.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Configuration validates lazily so a build does not need runtime secrets.
    // This restores fail-fast where it belongs: a misconfigured deployment dies
    // at startup rather than on its first request.
    const { assertConfigValid } = await import('@/core/config');
    assertConfigValid();

    // New Relic instruments Node at require-time by patching core modules, so it
    // must load before anything it is meant to observe.
    if (process.env.NEW_RELIC_ENABLED === 'true' && process.env.NEW_RELIC_LICENSE_KEY) {
      await import('newrelic');
    }

    const { initSentry } = await import('@/core/observability');
    initSentry('server');

    // Wires authentication into the HTTP kernel. Until this runs, every
    // authenticated route fails closed by design.
    // Goes through bootstrap() rather than wiring seams directly, so the
    // registration is idempotent and identical to the one the HTTP kernel
    // performs on its first request.
    const { bootstrap } = await import('@/bootstrap');
    bootstrap();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const { initSentry } = await import('@/core/observability');
    initSentry('edge');
  }
}

/**
 * Report errors thrown inside React Server Components and route handlers that
 * never reach our own kernel's try/catch.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | undefined> },
): Promise<void> {
  const { captureException } = await import('@/core/observability');
  captureException(error, { path: request.path, method: request.method });
}
