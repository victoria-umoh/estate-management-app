'use client';

import dynamic from 'next/dynamic';

/**
 * Toast host, loaded on demand.
 *
 * Sonner sits in the root layout, so importing it directly puts it in the chunk
 * every single route downloads — including API routes and the gate scanner,
 * neither of which will ever show a toast on first paint.
 *
 * `ssr: false` keeps it out of the shared bundle entirely. The cost is that the
 * first toast of a session waits on a small fetch, which is imperceptible next
 * to the interaction that triggered it.
 */
const SonnerToaster = dynamic(() => import('sonner').then((module) => module.Toaster), {
  ssr: false,
  loading: () => null,
});

export function Toaster() {
  return <SonnerToaster position="bottom-right" richColors closeButton />;
}
