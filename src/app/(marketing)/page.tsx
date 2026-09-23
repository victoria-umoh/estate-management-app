import { ClosingCta } from '@/components/marketing/closing-cta';
import { FeatureTour } from '@/components/marketing/feature-tour';
import { Hero } from '@/components/marketing/hero';

/**
 * Landing page.
 *
 * A server component: nothing above the fold needs state, and keeping it out of
 * the client boundary means the only JavaScript this route ships is the header,
 * the theme toggle and the hero's lazy canvas.
 */
export default function LandingPage() {
  return (
    <>
      <Hero />
      <FeatureTour />
      <ClosingCta />
    </>
  );
}
