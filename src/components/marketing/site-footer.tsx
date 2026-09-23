import Link from 'next/link';
import { ThemeToggle } from '@/components/ui/theme-toggle';

export function SiteFooter() {
  return (
    <footer className="border-border mt-20 border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:px-6">
        <p className="text-muted-foreground text-sm">
          PrimeEstate — estate and community management.
        </p>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-4 sm:ml-auto">
          <Link href="/pricing" className="rounded-md text-sm font-medium hover:underline">
            Pricing
          </Link>
          <Link href="/login" className="rounded-md text-sm font-medium hover:underline">
            Sign in
          </Link>
          {/* Duplicated from the header because the header's copy is hidden on
              phones, where the footer is the only place it fits. */}
          <ThemeToggle className="sm:hidden" />
        </nav>
      </div>
    </footer>
  );
}
