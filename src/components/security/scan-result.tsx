'use client';

import { AlertOctagon, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The gate's answer, as the officer sees it.
 *
 * Designed to be read in under a second, at arm's length, in sunlight, while
 * someone waits at the barrier. Colour, icon and a short verb all carry the
 * same message, because an officer glancing at a screen in bright light may
 * resolve only one of them.
 *
 * A blacklist is visually distinct from an ordinary refusal: "pass expired" and
 * "do not admit this person" call for very different responses.
 */
export interface ScanOutcome {
  admitted: boolean;
  message: string;
  reason?: string;
  credential?: {
    display: {
      primaryLabel: string;
      secondaryLabel?: string | null;
      unitNumber?: string | null;
      category?: string | null;
      photoUrl?: string | null;
    };
    validUntil?: string | null;
  };
}

export function ScanResult({ outcome }: { outcome: ScanOutcome }) {
  const blacklisted = outcome.reason === 'blacklisted';

  const tone = outcome.admitted ? 'admit' : blacklisted ? 'alarm' : 'deny';
  const Icon = outcome.admitted ? CheckCircle2 : blacklisted ? AlertOctagon : XCircle;

  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn(
        'rounded-2xl border-2 p-6 text-center transition-colors',
        {
          admit: 'border-success bg-success-muted',
          deny: 'border-danger bg-danger-muted',
          // A blacklist gets the strongest treatment available: solid fill, not
          // a tint, so it cannot be mistaken for a routine refusal.
          alarm: 'border-danger bg-danger text-danger-foreground',
        }[tone],
      )}
    >
      <Icon
        className={cn(
          'mx-auto size-16',
          tone === 'admit' && 'text-success',
          tone === 'deny' && 'text-danger',
          tone === 'alarm' && 'text-danger-foreground',
        )}
        aria-hidden
      />

      <p
        className={cn(
          'mt-3 text-2xl font-bold tracking-tight',
          tone === 'admit' && 'text-success',
          tone === 'deny' && 'text-danger',
        )}
      >
        {outcome.message}
      </p>

      {outcome.credential && (
        <div className="mt-5 space-y-1">
          <p className="text-xl font-semibold">{outcome.credential.display.primaryLabel}</p>

          {outcome.credential.display.unitNumber && (
            // The house number is the single most useful fact at a gate: it is
            // what the officer will say out loud to confirm.
            <p className="text-3xl font-bold tabular-nums">
              {outcome.credential.display.unitNumber}
            </p>
          )}

          {outcome.credential.display.category && (
            <p className="text-muted-foreground text-sm">{outcome.credential.display.category}</p>
          )}
          {outcome.credential.display.secondaryLabel && (
            <p className="text-muted-foreground text-sm">
              {outcome.credential.display.secondaryLabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
