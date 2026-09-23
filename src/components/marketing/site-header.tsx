'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/#what-it-does', label: 'What it does' },
  { href: '/pricing', label: 'Pricing' },
] as const;

/**
 * Marketing header.
 *
 * No hamburger: two links and a sign-in button fit on a 320px screen, and a
 * menu that has to be opened to reveal two items is worse than the items.
 */
export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="border-border bg-background/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <Link
          href="/"
          className="mr-auto flex items-center gap-2 rounded-md text-base font-semibold tracking-tight"
        >
          <ShieldCheck className="text-primary size-5" aria-hidden />
          EstateOS
        </Link>

        <nav aria-label="Main" className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={cn(
                'rounded-md px-2 py-2 text-sm font-medium transition-colors sm:px-3',
                // The in-page anchor is dropped on the narrowest screens: it
                // scrolls to a section a phone reaches by scrolling anyway, and
                // keeping it there pushes "Sign in" off the edge at 320px.
                item.href.includes('#') && 'hidden min-[380px]:inline-block',
                pathname === item.href
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <ThemeToggle className="hidden sm:inline-flex" />

        <Button asChild size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    </header>
  );
}
