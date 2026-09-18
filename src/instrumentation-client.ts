/**
 * Browser-side instrumentation.
 *
 * The Sentry browser SDK is ~80 kB. It is loaded through a dynamic import
 * guarded by the DSN check so that a deployment with Sentry disabled — the
 * default — does not pay for it on first load. This matters most on the gate
 * scanner, which runs on cheap tablets over poor connections.
 *
 * Session replay is off: these screens display NIN, addresses and minors'
 * records. See src/core/observability/sentry.ts.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

type TransitionHook = (href: string, navigationType: string) => void;

let routerTransitionHook: TransitionHook = () => {};

if (dsn) {
  void import('@sentry/nextjs').then((Sentry) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'development',
      tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0),
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      sendDefaultPii: false,
    });

    routerTransitionHook = Sentry.captureRouterTransitionStart as TransitionHook;
  });
}

// Next calls this on every client navigation. It delegates to Sentry once the
// SDK has loaded, and is a no-op otherwise.
export const onRouterTransitionStart: TransitionHook = (href, navigationType) => {
  routerTransitionHook(href, navigationType);
};
