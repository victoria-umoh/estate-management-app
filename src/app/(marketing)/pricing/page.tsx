import type { Metadata } from 'next';
import { Pricing } from '@/components/marketing/pricing';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'PrimeEstate pricing: per unit, per month, billed monthly or yearly. 30 days of Professional free, no card required.',
};

export default function PricingPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="max-w-prose">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Priced per unit, per month
        </h1>
        <p className="text-muted-foreground mt-4 text-pretty">
          You pay for the units in the estate, not for seats or gates — an estate of 80 units costs
          the same whether two people administer it or ten. Every plan starts with 30 days of
          Professional, free and without a card.
        </p>
      </div>

      <div className="mt-10">
        <Pricing />
      </div>
    </div>
  );
}
