'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, Copy, Plus, Ticket, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';

/**
 * The passes this resident is hosting.
 *
 * Two pieces of the created pass are treated very differently. The code is
 * quoted aloud down a phone line, so it is rendered large, monospaced and
 * widely tracked — the alphabet already excludes characters that read alike,
 * and a proportional font would throw that away. The token is the credential
 * itself, returned once and unrecoverable; it is held in component state for
 * as long as the receipt is open and never written to storage, so closing the
 * dialog genuinely destroys it. The screen says so rather than letting someone
 * discover it later.
 */
interface VisitorPass {
  id: string;
  code: string;
  passType: string;
  visitorName: string;
  visitorPhone: string | null;
  partySize: number;
  purpose: string;
  vehiclePlate: string | null;
  expectedArrival: string;
  expectedDeparture: string;
  status: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

interface CreatedPass {
  id: string;
  code: string;
  visitorName: string;
  expectedArrival: string;
  expectedDeparture: string;
  status: string;
  token: string;
}

const PAGE_SIZE = 20;

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'info',
  active: 'info',
  'checked-in': 'success',
  'checked-out': 'neutral',
  expired: 'neutral',
  cancelled: 'danger',
  denied: 'danger',
};

export default function MyVisitorsPage() {
  const [passes, setPasses] = useState<VisitorPass[] | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [created, setCreated] = useState<CreatedPass | null>(null);

  const load = useCallback(async () => {
    try {
      // No host id is sent: the server takes it from the session, so this list
      // can only ever be the caller's own passes.
      setPasses(await api.get<VisitorPass[]>(`/me/visitors?page=${page}&limit=${PAGE_SIZE}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(pass: VisitorPass) {
    try {
      await api.post(`/me/visitors/${pass.id}/cancel`, {});
      toast.success(`Pass ${pass.code} cancelled`);
      await load();
    } catch {
      toast.error('Could not cancel that pass.');
    }
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">My visitors</h1>
        <CreatePassDialog
          onCreated={(pass) => {
            setCreated(pass);
            setPage(1);
            void load();
          }}
        />
      </div>

      {created && <PassReceipt pass={created} onDismiss={() => setCreated(null)} />}

      <Card>
        <CardHeader>
          <CardTitle>Passes</CardTitle>
        </CardHeader>
        <CardContent>
          {passes === null ? (
            <SkeletonTable rows={5} columns={3} />
          ) : passes.length === 0 ? (
            <EmptyState
              icon={<Ticket aria-hidden />}
              title={page > 1 ? 'Nothing on this page' : 'No passes yet'}
              description="Passes you create for guests appear here, newest first."
            />
          ) : (
            <ul className="divide-border divide-y">
              {passes.map((pass) => (
                <li key={pass.id} className="flex flex-wrap items-center gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{pass.visitorName}</span>
                      <Badge tone={TONE[pass.status] ?? 'neutral'} size="sm" dot>
                        {pass.status}
                      </Badge>
                      {pass.partySize > 1 && (
                        <Badge tone="neutral" size="sm">
                          party of {pass.partySize}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {pass.purpose}
                      {pass.vehiclePlate ? ` · ${pass.vehiclePlate}` : ''}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
                      {formatWhen(pass.expectedArrival)} → {formatWhen(pass.expectedDeparture)}
                    </p>
                  </div>

                  <CopyableCode code={pass.code} />

                  {canCancel(pass.status) && (
                    <ConfirmDialog
                      trigger={
                        <Button variant="outline" size="sm">
                          Cancel
                        </Button>
                      }
                      title={`Cancel ${pass.visitorName}'s pass?`}
                      description="The code stops working immediately and the guest will be turned away at the gate. You can issue a new pass afterwards."
                      confirmLabel="Cancel pass"
                      cancelLabel="Keep it"
                      tone="danger"
                      onConfirm={() => cancel(pass)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || passes === null}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              // The list endpoint hands back the page only, so a short page is
              // the end of the list.
              disabled={passes === null || passes.length < PAGE_SIZE}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CreatePassDialog({ onCreated }: { onCreated: (pass: CreatedPass) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();

    const arrival = text('expectedArrival');
    const departure = text('expectedDeparture');
    const partySize = Number(text('partySize') || '1');

    if (departure && arrival && new Date(departure) <= new Date(arrival)) {
      setProblem('The departure time must be after the arrival time.');
      setBusy(false);
      return;
    }

    try {
      const created = await api.post<CreatedPass>('/me/visitors', {
        visitorName: text('visitorName'),
        purpose: text('purpose'),
        partySize,
        // The API rejects empty strings for these, so they are omitted rather
        // than sent blank.
        ...(text('visitorPhone') ? { visitorPhone: text('visitorPhone') } : {}),
        ...(text('vehiclePlate') ? { vehiclePlate: text('vehiclePlate') } : {}),
        expectedArrival: new Date(arrival).toISOString(),
        expectedDeparture: new Date(departure).toISOString(),
      });

      setOpen(false);
      onCreated(created);
    } catch {
      setProblem('Could not create the pass. Check the details and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          New pass
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a visitor</DialogTitle>
          <DialogDescription>
            The gate will admit them against the code this creates.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          <Input name="visitorName" label="Visitor name" required minLength={2} maxLength={120} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="visitorPhone"
              label="Phone"
              type="tel"
              maxLength={20}
              hint="Optional"
              autoComplete="off"
            />
            <Input
              name="partySize"
              label="Party size"
              type="number"
              min={1}
              max={50}
              defaultValue={1}
            />
          </div>

          <Input name="purpose" label="Purpose of visit" required minLength={2} maxLength={200} />

          <Input
            name="vehiclePlate"
            label="Vehicle plate"
            maxLength={20}
            hint="Optional — speeds them through the gate"
            className="uppercase"
            autoComplete="off"
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="expectedArrival" label="Expected arrival" type="datetime-local" required />
            <Input
              name="expectedDeparture"
              label="Expected departure"
              type="datetime-local"
              required
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create pass
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The one and only sight of a new pass's token.
 *
 * Rendered from state and deliberately not persisted: there is no second
 * chance to read it, and storing it would move a live credential somewhere any
 * script on the origin could reach.
 */
function PassReceipt({ pass, onDismiss }: { pass: CreatedPass; onDismiss: () => void }) {
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { toDataURL } = await import('qrcode');
      const url = await toDataURL(pass.token, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
      if (!cancelled) setQr(url);
    })();

    return () => {
      cancelled = true;
    };
  }, [pass.token]);

  return (
    <Card className="border-success">
      <CardHeader>
        <CardTitle className="text-success flex items-center gap-2">
          <Check className="size-5" aria-hidden />
          Pass created for {pass.visitorName}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-2">
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            Gate code — read this out to your guest
          </p>
          <BigCode code={pass.code} />
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr}
              alt={`QR code for ${pass.visitorName}'s pass`}
              className="size-40 shrink-0 rounded-lg bg-white p-2"
            />
          )}
          <Alert tone="warning" className="flex-1">
            <span className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                This QR is shown once and cannot be retrieved again. Send it to your guest now — if
                you close this, you will need to issue a new pass. The gate code above stays
                available in the list below.
              </span>
            </span>
          </Alert>
        </div>

        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CalendarClock className="size-3.5" aria-hidden />
          Valid {formatWhen(pass.expectedArrival)} → {formatWhen(pass.expectedDeparture)}
        </p>

        <Button variant="outline" block onClick={onDismiss}>
          Done — discard the QR
        </Button>
      </CardContent>
    </Card>
  );
}

function BigCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="hover:bg-muted focus-visible:ring-ring rounded-lg px-4 py-2 font-mono text-4xl font-bold tracking-[0.25em] tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none sm:text-5xl"
      onClick={() => {
        void navigator.clipboard?.writeText(code);
        setCopied(true);
        toast.success('Code copied');
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={`Copy gate code ${code.split('').join(' ')}`}
    >
      {code}
      <Copy className="text-muted-foreground ml-3 inline size-4 align-middle" aria-hidden />
      <span className="sr-only">{copied ? 'Copied' : ''}</span>
    </button>
  );
}

function CopyableCode({ code }: { code: string }) {
  return (
    <button
      type="button"
      className="bg-muted hover:bg-muted/70 focus-visible:ring-ring rounded-md px-2.5 py-1 font-mono text-sm font-semibold tracking-[0.18em] transition-colors focus-visible:ring-2 focus-visible:outline-none"
      onClick={() => {
        void navigator.clipboard?.writeText(code);
        toast.success('Code copied');
      }}
      aria-label={`Copy gate code ${code.split('').join(' ')}`}
    >
      {code}
    </button>
  );
}

function canCancel(status: string): boolean {
  return status === 'pending' || status === 'active';
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
