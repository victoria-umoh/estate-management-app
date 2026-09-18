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

let done = false;

export function bootstrap(): void {
  if (done) return;
  done = true;

  registerAuthContextResolver();
}
