'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowDownLeft, ArrowUpRight, Ban, Car, Hash, QrCode, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QrScanner } from '@/components/security/qr-scanner';
import { ScanResult, type ScanOutcome } from '@/components/security/scan-result';
import { api, ApiRequestError } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The gate.
 *
 * This is the screen the whole latency design exists for: a tablet on a stand,
 * one officer, a queue of cars, poor light and worse connectivity.
 *
 * Choices follow from that, not from taste:
 *  - No 3D and no route-level animation. Nothing decorative loads here.
 *  - Direction and gate are chosen once at the start of a shift and then left.
 *  - Controls are at the bottom, within thumb reach on a held tablet.
 *  - Every scan leaves a record whatever the outcome, so the officer never has
 *    to remember to log a refusal.
 *  - "Deny entry" covers what a scan cannot see — no pass at all, a plate that
 *    was only looked up, or a valid pass the officer will not honour. It is
 *    never offered after a refused scan, which is already logged, so the log
 *    does not count one refusal twice. Its dialog loads only when opened.
 */
const DenyEntryDialog = dynamic(() => import('./deny-entry-dialog'), { ssr: false });

type Mode = 'qr' | 'code' | 'plate';
type Direction = 'in' | 'out';

interface Gate {
  id: string;
  name: string;
  code: string;
  status: string;
}

export default function GateScanPage() {
  const [gates, setGates] = useState<Gate[]>([]);
  const [gateId, setGateId] = useState<string>('');
  const [direction, setDirection] = useState<Direction>('in');
  const [mode, setMode] = useState<Mode>('qr');

  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  // Scans and codes write their own movement; a plate lookup writes nothing.
  const [outcomeLogged, setOutcomeLogged] = useState(false);
  const [denying, setDenying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualValue, setManualValue] = useState('');

  useEffect(() => {
    api
      .get<Gate[]>('/gates')
      .then((result) => {
        setGates(result);
        // Remembered across reloads: an officer works one gate for a whole
        // shift and should not re-select it every time the tablet sleeps.
        const remembered = localStorage.getItem('gateId');
        const usable = result.find((gate) => gate.id === remembered) ?? result[0];
        if (usable) setGateId(usable.id);
      })
      .catch(() => toast.error('Could not load gates.'));
  }, []);

  useEffect(() => {
    if (gateId) localStorage.setItem('gateId', gateId);
  }, [gateId]);

  const submit = useCallback(
    async (payload: { token?: string; code?: string }) => {
      if (!gateId) {
        toast.error('Choose a gate first.');
        return;
      }

      setBusy(true);
      try {
        const result = payload.token
          ? await api.post<ScanOutcome>('/gate/scan', {
              token: payload.token,
              gateId,
              direction,
            })
          : await api.post<ScanOutcome>('/gate/code', {
              code: payload.code,
              gateId,
              direction,
            });

        setOutcome(result);
        setOutcomeLogged(true);
        setManualValue('');

        // Sound and vibration, because the officer is usually looking at the
        // vehicle rather than the screen when the answer arrives.
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(result.admitted ? 60 : [80, 60, 80]);
        }
      } catch (error) {
        const message =
          error instanceof ApiRequestError ? error.message : 'Could not reach the server.';
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [gateId, direction],
  );

  const lookupPlate = useCallback(async () => {
    if (!manualValue.trim()) return;

    setBusy(true);
    try {
      const result = await api.get<{
        found: boolean;
        plateNumber?: string;
        description?: string;
        status?: string;
        blacklisted?: boolean;
        blacklistReason?: string | null;
      }>(`/gate/plate?plate=${encodeURIComponent(manualValue.trim())}`);

      setOutcome(
        result.found
          ? {
              admitted: !result.blacklisted && result.status === 'active',
              message: result.blacklisted
                ? 'DO NOT ADMIT. Refer to security.'
                : result.status === 'active'
                  ? 'Registered vehicle.'
                  : `Vehicle is ${result.status}.`,
              ...(result.blacklisted ? { reason: 'blacklisted' } : {}),
              credential: {
                display: {
                  primaryLabel: result.plateNumber ?? manualValue,
                  secondaryLabel: result.blacklistReason ?? result.description ?? null,
                  unitNumber: null,
                  category: 'Vehicle',
                  photoUrl: null,
                },
              },
            }
          : {
              admitted: false,
              message: 'Plate not registered.',
              reason: 'unknown-credential',
            },
      );
      setOutcomeLogged(false);
      setManualValue('');
    } catch {
      toast.error('Lookup failed.');
    } finally {
      setBusy(false);
    }
  }, [manualValue]);

  const activeGate = gates.find((gate) => gate.id === gateId);

  // The API records denials as entries only, so the action follows the
  // direction switch rather than offering something it cannot log.
  const canDeny =
    direction === 'in' && Boolean(gateId) && (!outcome || outcome.admitted || !outcomeLogged);

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-24">
      {/* --- Shift settings: chosen once, then ignored -------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={gateId}
          onChange={(event) => setGateId(event.target.value)}
          aria-label="Gate"
          className="border-input bg-background h-11 flex-1 rounded-md border px-3 text-sm"
        >
          {gates.length === 0 && <option value="">No gates configured</option>}
          {gates.map((gate) => (
            <option key={gate.id} value={gate.id}>
              {gate.code} — {gate.name}
            </option>
          ))}
        </select>

        <div className="bg-muted flex rounded-md p-0.5" role="group" aria-label="Direction">
          {(['in', 'out'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDirection(value)}
              aria-pressed={direction === value}
              className={cn(
                'flex h-10 items-center gap-1.5 rounded px-4 text-sm font-medium transition-colors',
                direction === value
                  ? 'bg-background text-foreground shadow-subtle'
                  : 'text-muted-foreground',
              )}
            >
              {value === 'in' ? (
                <ArrowDownLeft className="size-4" aria-hidden />
              ) : (
                <ArrowUpRight className="size-4" aria-hidden />
              )}
              {value === 'in' ? 'Entry' : 'Exit'}
            </button>
          ))}
        </div>
      </div>

      {activeGate && activeGate.status !== 'open' && (
        <p className="bg-warning-muted text-warning rounded-md px-3 py-2 text-sm font-medium">
          {activeGate.code} is {activeGate.status}.
        </p>
      )}

      {/* --- Result, or the scanner -------------------------------------- */}
      {outcome ? (
        <div className="space-y-3">
          <ScanResult outcome={outcome} />
          <Button size="lg" block variant="outline" onClick={() => setOutcome(null)}>
            <RotateCcw aria-hidden />
            Next
          </Button>
          {canDeny ? (
            <Button
              size="lg"
              block
              variant="ghost"
              className="text-danger"
              onClick={() => setDenying(true)}
            >
              <Ban aria-hidden />
              {outcome.admitted ? 'Refuse anyway' : 'Record refusal'}
            </Button>
          ) : (
            !outcome.admitted && (
              <p className="text-muted-foreground text-center text-xs">
                This refusal is already in the gate log.
              </p>
            )
          )}
        </div>
      ) : (
        <>
          <div className="bg-muted flex rounded-lg p-0.5" role="tablist">
            {(
              [
                ['qr', 'Scan', QrCode],
                ['code', 'Code', Hash],
                ['plate', 'Plate', Car],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                role="tab"
                aria-selected={mode === value}
                onClick={() => {
                  setMode(value);
                  setManualValue('');
                }}
                className={cn(
                  'flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
                  mode === value
                    ? 'bg-background text-foreground shadow-subtle'
                    : 'text-muted-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          {mode === 'qr' && (
            <QrScanner onScan={(token) => void submit({ token })} paused={busy || denying} />
          )}

          {mode !== 'qr' && (
            <div className="space-y-3">
              <Input
                label={mode === 'code' ? 'Visitor code' : 'Plate number'}
                placeholder={mode === 'code' ? 'ABC123' : 'ABC-123-XY'}
                value={manualValue}
                onChange={(event) => setManualValue(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  void (mode === 'code' ? submit({ code: manualValue }) : lookupPlate());
                }}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                // The officer is typing, not tapping through a form.
                autoFocus
                className="h-14 text-center text-2xl tracking-widest"
              />

              <Button
                size="lg"
                block
                loading={busy}
                onClick={() =>
                  void (mode === 'code' ? submit({ code: manualValue }) : lookupPlate())
                }
                // Also waits for a gate. The list loads asynchronously, and
                // the button used to be live before it arrived — so a quick
                // officer on a slow tablet got "Choose a gate first" for a gate
                // that was about to select itself.
                disabled={!manualValue.trim() || !gateId}
              >
                {mode === 'code' ? 'Check code' : 'Look up plate'}
              </Button>
            </div>
          )}

          {canDeny && (
            <Button
              size="lg"
              block
              variant="ghost"
              className="text-danger"
              onClick={() => setDenying(true)}
            >
              <Ban aria-hidden />
              Deny entry — no pass
            </Button>
          )}
        </>
      )}

      {denying && activeGate && (
        <DenyEntryDialog
          gateId={activeGate.id}
          gateLabel={activeGate.code}
          subject={outcome?.credential?.display.primaryLabel ?? ''}
          onClose={() => setDenying(false)}
          onRecorded={() => {
            setDenying(false);
            setOutcome(null);
          }}
        />
      )}
    </div>
  );
}
