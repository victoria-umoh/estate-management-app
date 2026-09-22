'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Printer, RefreshCw, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The resident's digital ID card.
 *
 * The flip is a CSS 3D transform, not a WebGL scene. Loading a renderer to turn
 * a rectangle over would cost hundreds of kilobytes for an effect the browser
 * performs natively on the compositor — and this card is opened at a gate, on a
 * phone, often on a poor connection.
 *
 * The QR is generated in the browser from a token that is never persisted, so
 * the credential is not sitting in storage waiting to be read by anything else.
 */
interface IdCard {
  token: string;
  fullName: string;
  category: string;
  unitNumber: string | null;
  residentCode: string | null;
  photoUrl: string | null;
  status: string;
}

export default function DigitalIdPage() {
  const [card, setCard] = useState<IdCard | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const membershipId = localStorage.getItem('membershipId');
      if (!membershipId) {
        setFailed(true);
        return;
      }

      const result = await api.post<IdCard>('/me/id-card', { membershipId });
      setCard(result);

      // Imported here, not at module scope: the QR library is only needed by
      // this one screen.
      const { toDataURL } = await import('qrcode');
      setQrDataUrl(
        await toDataURL(result.token, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 320,
          color: { dark: '#000000', light: '#ffffff' },
        }),
      );

      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <ErrorState
        title="Could not load your ID"
        description="Your membership may still be awaiting approval."
        onRetry={() => void load()}
      />
    );
  }

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div
        className="[perspective:1400px]"
        // The whole card is the control, so a tap anywhere turns it over.
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show card front' : 'Show QR code'}
        onClick={() => setFlipped((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setFlipped((value) => !value);
          }
        }}
      >
        <div
          className={cn(
            'relative aspect-[1.586] w-full transition-transform duration-500 [transform-style:preserve-3d]',
            // Collapses to an instant swap under reduced motion.
            'motion-reduce:duration-0',
            flipped && '[transform:rotateY(180deg)]',
          )}
        >
          {/* --- Front ---------------------------------------------------- */}
          <div className="absolute inset-0 [backface-visibility:hidden]">
            <div className="from-primary to-primary/80 text-primary-foreground shadow-overlay flex h-full flex-col justify-between rounded-2xl bg-gradient-to-br p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[11px] font-medium tracking-widest uppercase opacity-80">
                    Estate Resident
                  </p>
                  {card?.residentCode && (
                    <p className="mt-0.5 font-mono text-xs opacity-90">{card.residentCode}</p>
                  )}
                </div>
                {card && (
                  <Badge
                    tone={card.status === 'active' ? 'success' : 'warning'}
                    dot
                    className="bg-white/15 text-white"
                  >
                    {card.status}
                  </Badge>
                )}
              </div>

              <div className="flex items-end gap-3">
                <div className="size-16 shrink-0 overflow-hidden rounded-lg bg-white/15">
                  {card?.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.photoUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-xl font-semibold">
                      {card?.fullName.slice(0, 1) ?? '·'}
                    </span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg leading-tight font-semibold">
                    {card?.fullName ?? 'Loading…'}
                  </p>
                  <p className="text-sm capitalize opacity-85">
                    {card?.category.replace(/-/g, ' ')}
                  </p>
                </div>

                {card?.unitNumber && (
                  <div className="text-right">
                    <p className="text-[10px] tracking-wide uppercase opacity-70">Unit</p>
                    <p className="text-2xl leading-none font-bold tabular-nums">
                      {card.unitNumber}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* --- Back: the QR --------------------------------------------- */}
          <div className="absolute inset-0 [transform:rotateY(180deg)] [backface-visibility:hidden]">
            <div className="bg-card border-border shadow-overlay flex h-full items-center justify-center rounded-2xl border p-4">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="Your pass QR code" className="h-full w-auto rounded-lg" />
              ) : (
                <Loader2 className="text-muted-foreground size-8 animate-spin" aria-hidden />
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="text-muted-foreground text-center text-sm">
        <RotateCw className="mr-1 inline size-3.5" aria-hidden />
        Tap the card to show your QR code
      </p>

      <div className="flex gap-2">
        <Button
          variant="outline"
          block
          loading={busy}
          onClick={() => {
            void load();
            toast.success('ID refreshed');
          }}
        >
          <RefreshCw aria-hidden />
          Refresh
        </Button>
        <Button variant="outline" block onClick={() => window.print()}>
          <Printer aria-hidden />
          Print
        </Button>
      </div>
    </div>
  );
}
