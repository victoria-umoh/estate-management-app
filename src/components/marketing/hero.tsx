import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { HeroCanvas } from '@/components/three/hero-canvas';

/**
 * Landing hero.
 *
 * The copy leads with the four things a chairman is buying — a resident
 * register, a gate that checks people, an incident log and dues collection —
 * because "operating system for communities" tells them nothing they can
 * evaluate.
 *
 * One canvas, moved by CSS rather than duplicated per breakpoint: two instances
 * would mount two WebGL contexts, and the hidden one still costs a GPU surface.
 */
export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto w-full max-w-6xl px-4 pt-12 pb-16 sm:px-6 sm:pt-20 sm:pb-24">
        <div className="lg:max-w-[46%]">
          <p className="text-primary text-xs font-semibold tracking-widest uppercase">
            Estate &amp; community management
          </p>

          <h1 className="mt-3 text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
            Know who lives here, and who just drove in.
          </h1>

          <p className="text-muted-foreground mt-5 max-w-prose text-base text-pretty sm:text-lg">
            EstateOS keeps one verified register of residents, households and vehicles, checks every
            visitor at the gate against it, records incidents as they happen, and bills dues with a
            ledger that reconciles. Security officers work it on a tablet; residents use their
            phones.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href="/pricing">See pricing</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>

          <p className="text-muted-foreground mt-4 text-sm">
            30 days of Professional, no card required.
          </p>
        </div>

        <div
          // Faded at its inner edge so the scene meets the copy as a
          // gradient rather than a hard rectangle, at any text length.
          className="mt-12 h-56 sm:h-72 lg:absolute lg:inset-y-0 lg:right-0 lg:mt-0 lg:h-auto lg:w-[54%] lg:[mask-image:linear-gradient(to_right,transparent,black_22%)]"
        >
          <HeroCanvas className="h-full w-full" />
        </div>
      </div>
    </section>
  );
}
