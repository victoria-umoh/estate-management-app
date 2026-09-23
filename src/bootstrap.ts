/**
 * Runtime wiring.
 *
 * Connects implementations to the seams the core layer defines — currently
 * authentication, later notifications and device adapters.
 *
 * This exists as its own module because `instrumentation.ts` alone is not a
 * reliable place to do it. Next may evaluate instrumentation in a different
 * module graph from the route handlers, so a singleton set there is not
 * guaranteed to be the one a route observes. The HTTP kernel therefore calls
 * `bootstrap()` itself, via dynamic import, on the first request it serves.
 *
 * Idempotent, so running from both places is harmless.
 */
import { registerAuthContextResolver } from '@/modules/auth';
import { registerNotificationHandlers, registerNotificationJobs } from '@/modules/notification';

let done = false;

export function bootstrap(): void {
  if (done) return;
  done = true;

  registerAuthContextResolver();

  // Domain events that should tell somebody something. Registered here rather
  // than in instrumentation.ts for the reason described above: a subscription
  // made in the instrumentation module graph is not necessarily the one a route
  // handler's event bus observes, and the symptom is silence — notifications
  // that simply never arrive, with nothing in the logs to say why.
  registerNotificationHandlers();

  // Outbound email and SMS job handlers. Async, and deliberately not awaited:
  // bootstrap runs on the first request and must not add a queue round-trip to
  // it. Anything enqueued before this resolves is held by the queue, not lost.
  void registerNotificationJobs().catch(() => {
    // Logged by the queue itself; swallowed here so a queue that is briefly
    // unreachable cannot take the first request down with it.
  });
}
