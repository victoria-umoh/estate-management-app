import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function ClosingCta() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <div className="border-border bg-primary-muted rounded-xl border px-6 py-10 sm:px-10 sm:py-12">
        <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Try it on your own estate for 30 days
        </h2>
        <p className="text-foreground/80 mt-3 max-w-prose text-pretty">
          The trial runs the full Professional plan — dues, incidents and reporting included — for
          up to 100 units. No card, and nothing to uninstall if you stop.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/pricing">See what it costs</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
