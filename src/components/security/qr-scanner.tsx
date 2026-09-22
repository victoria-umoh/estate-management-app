'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Camera QR scanner.
 *
 * The decoder (`@zxing/browser`) is imported dynamically, so the roughly
 * 200 kB it costs is paid only by the one screen that scans — not by every
 * route, and not by a resident who never opens the gate interface.
 *
 * Duplicate reads are suppressed for a short window. A QR code in front of a
 * camera decodes many times a second, and without this a single presentation
 * would fire a dozen verification requests and a dozen movement records.
 */
export interface QrScannerProps {
  onScan: (value: string) => void;
  /** Pauses decoding while a result is on screen. */
  paused?: boolean;
  className?: string;
}

const DUPLICATE_WINDOW_MS = 2500;

export function QrScanner({ onScan, paused = false, className }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScanRef = useRef<{ value: string; at: number } | null>(null);

  const [state, setState] = useState<'starting' | 'running' | 'denied' | 'unavailable'>('starting');

  const handleDecode = useCallback(
    (value: string) => {
      const previous = lastScanRef.current;
      const now = Date.now();

      if (previous && previous.value === value && now - previous.at < DUPLICATE_WINDOW_MS) {
        return;
      }

      lastScanRef.current = { value, at: now };
      onScan(value);
    },
    [onScan],
  );

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        setState('unavailable');
        return;
      }

      try {
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        if (cancelled) return;

        const reader = new BrowserQRCodeReader();

        const controls = await reader.decodeFromConstraints(
          // The rear camera, which is the one pointed at a windscreen.
          { video: { facingMode: 'environment' } },
          videoRef.current!,
          (result) => {
            if (result) handleDecode(result.getText());
          },
        );

        if (cancelled) {
          controls.stop();
          return;
        }

        controlsRef.current = controls;
        setState('running');
      } catch (error) {
        if (cancelled) return;

        const denied =
          error instanceof Error &&
          (error.name === 'NotAllowedError' || error.name === 'NotFoundError');

        setState(denied ? 'denied' : 'unavailable');
      }
    }

    void start();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [handleDecode]);

  return (
    <div
      className={cn('relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black', className)}
    >
      <video
        ref={videoRef}
        className="size-full object-cover"
        muted
        playsInline
        aria-label="Camera view for scanning passes"
      />

      {state === 'running' && (
        <>
          {/* A framing guide, so the officer knows where to hold the code. */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div
              className={cn(
                'size-48 rounded-xl border-4 transition-colors sm:size-56',
                paused ? 'border-white/30' : 'border-white/80',
              )}
            />
          </div>

          {paused && (
            <div className="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-center text-sm text-white">
              Paused — clear the result to scan again
            </div>
          )}
        </>
      )}

      {state === 'starting' && (
        <div className="absolute inset-0 grid place-items-center text-white">
          <Loader2 className="size-8 animate-spin" aria-hidden />
        </div>
      )}

      {(state === 'denied' || state === 'unavailable') && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
          <div>
            <CameraOff className="mx-auto size-8" aria-hidden />
            <p className="mt-2 font-medium">
              {state === 'denied' ? 'Camera access blocked' : 'No camera available'}
            </p>
            {/* The fallback is always present, so this is an inconvenience
                rather than a stoppage. */}
            <p className="mt-1 text-sm text-white/70">Use the code or plate tabs instead.</p>
          </div>
        </div>
      )}
    </div>
  );
}
