import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';

/**
 * Marketing chrome.
 *
 * The landing page lives in this group rather than at `src/app/page.tsx` so it
 * shares a header and footer with pricing. It still resolves to `/` — a route
 * group is a folder, not a path segment — but it keeps its own bundle budget
 * key, `/(marketing)`, away from the app routes.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
