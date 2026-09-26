'use client';

import { useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';

/**
 * Copy the self-registration link for this estate.
 *
 * Registration names its estate by id, and nothing public turns a name into
 * one, so the office has to hand the link out — in a WhatsApp group, on the
 * gatehouse notice. The link grants nothing by itself: everyone who registers
 * through it still lands in the approval queue.
 */
export function RegistrationLinkButton() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      const estate = await api.get<{ id: string }>('/estate');
      await navigator.clipboard.writeText(
        `${window.location.origin}/register?estate=${encodeURIComponent(estate.id)}`,
      );
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2500);
  }

  return (
    <Button variant="outline" onClick={() => void copy()} aria-live="polite">
      {state === 'copied' ? <Check aria-hidden /> : <Link2 aria-hidden />}
      {state === 'copied'
        ? 'Link copied'
        : state === 'failed'
          ? 'Could not copy'
          : 'Copy registration link'}
    </Button>
  );
}
