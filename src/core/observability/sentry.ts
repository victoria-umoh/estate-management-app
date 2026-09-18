import * as Sentry from '@sentry/nextjs';
import { config } from '@/core/config';
import { getLogContext } from '@/core/logging';
import { scrubObject, scrubText, scrubUrl } from './scrub';

/**
 * Sentry initialisation.
 *
 * Disabled entirely when no DSN is configured — no SDK setup, no network calls.
 * That is the default, so a fresh checkout reports nothing anywhere.
 *
 * Session replay defaults to OFF. Replay records screen contents, and these
 * screens show NIN, addresses and minors' records; enabling it without masking
 * configured would export exactly the data the rest of the design protects.
 */
export function initSentry(runtime: 'server' | 'edge' | 'client'): void {
  const settings = config.observability.sentry;
  const dsn = runtime === 'client' ? settings.publicDsn : settings.dsn;

  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: settings.environment,
    tracesSampleRate: settings.tracesSampleRate,
    replaysSessionSampleRate: settings.replaysSessionSampleRate,
    replaysOnErrorSampleRate: settings.replaysOnErrorSampleRate,

    // Never ship IPs or usernames by default; attribution comes from our own
    // correlation ID instead.
    sendDefaultPii: false,

    beforeSend(event) {
      if (event.request?.url) event.request.url = scrubUrl(event.request.url);
      if (event.request?.data) event.request.data = scrubObject(event.request.data);
      if (event.request?.headers) event.request.headers = scrubObject(event.request.headers);
      if (event.extra) event.extra = scrubObject(event.extra);

      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = scrubText(exception.value);
      }
      if (event.message) event.message = scrubText(event.message);

      // Tie the Sentry event to our logs and audit trail.
      const context = getLogContext();
      if (context) {
        event.tags = {
          ...event.tags,
          correlationId: context.correlationId,
          ...(context.estateId ? { estateId: context.estateId } : {}),
        };
      }

      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) breadcrumb.data = scrubObject(breadcrumb.data);
      if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
      return breadcrumb;
    },
  });
}

/**
 * Report an error.
 *
 * Operational errors (bad input, missing record) are expected and are not
 * reported — they would drown the genuine bugs in noise.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!config.observability.sentry.enabled) return;

  const isOperational =
    typeof error === 'object' &&
    error !== null &&
    (error as { isOperational?: boolean }).isOperational;
  if (isOperational) return;

  Sentry.captureException(error, context ? { extra: scrubObject(context) } : undefined);
}
