'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Clock,
  PackageCheck,
  Repeat,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api, ApiRequestError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { TemporaryPassDetailDialog } from './temporary-pass-detail';

/**
 * The passes desk: exit passes and temporary passes in one place.
 *
 * Verification is the screen's centre of gravity. The officer types a code and
 * both verify endpoints are asked, because the person at the barrier does not
 * announce which kind of pass they hold. Whichever recognises the code answers,
 * and the answer is rendered in full — including when it is a refusal, since
 * both endpoints return the pass anyway and the officer needs the manifest in
 * front of them to explain why the load is not going through.
 *
 * The two types are shown differently on purpose. An exit pass is spent at the
 * barrier and closes; a temporary pass is reusable inside its window and only
 * counts passages. Nothing here offers to "use up" a temporary pass.
 *
 * What the lists below hold depends on the role: the server narrows exit passes
 * to the caller's own household for anyone without `exitPass.approve`, so an
 * officer sees empty lists and works entirely by code. That is stated on the
 * screen rather than left looking like a loading failure.
 *
 * A temporary pass opens into its full record, from the list or from a
 * verification. Revoking it is a supervisor's permission, resolved by the page
 * on the server and passed in, so an officer is never shown a button that
 * would only answer 403.
 */
interface Gate {
  id: string;
  name: string;
  code: string;
  status: string;
}

interface ManifestItem {
  quantity: number;
  description: string;
  identifyingMark: string | null;
  estimatedValue: number | null;
}

interface ExitPassSummary {
  id: string;
  code: string;
  carrierName: string;
  destination: string;
  reason: string;
  itemCount: number;
  totalQuantity: number;
  status: string;
  validFrom: string;
  validUntil: string;
}

interface TemporaryPassSummary {
  id: string;
  code: string;
  holderName: string;
  company: string | null;
  purpose: string;
  status: string;
  validFrom: string;
  validUntil: string;
  useCount: number;
  inside: boolean;
  lastUsedAt: string | null;
}

interface ExitVerification {
  usable: boolean;
  message: string;
  pass: {
    id: string;
    code: string;
    carrierName: string;
    carrierPhone: string | null;
    destination: string;
    reason: string;
    vehiclePlate: string | null;
    items: ManifestItem[];
    status: string;
    validUntil: string;
  } | null;
}

interface TemporaryVerification {
  usable: boolean;
  message: string;
  pass: {
    id: string;
    code: string;
    holderName: string;
    company: string | null;
    purpose: string;
    vehiclePlate: string | null;
    status: string;
    validUntil: string;
    useCount: number;
    inside: boolean;
  } | null;
}

type Verification =
  | { kind: 'exit'; result: ExitVerification }
  | { kind: 'temporary'; result: TemporaryVerification }
  | { kind: 'unknown'; code: string };

const REFRESH_MS = 30_000;

export function PassesDesk({ canRevoke }: { canRevoke: boolean }) {
  const [gates, setGates] = useState<Gate[]>([]);
  const [gateId, setGateId] = useState('');
  const [pending, setPending] = useState<ExitPassSummary[] | null>(null);
  const [approved, setApproved] = useState<ExitPassSummary[] | null>(null);
  const [temporary, setTemporary] = useState<TemporaryPassSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pendingResult, approvedResult, temporaryResult] = await Promise.all([
        api.getPage<ExitPassSummary>('/exit-passes?status=pending&limit=25'),
        api.getPage<ExitPassSummary>('/exit-passes?status=approved&limit=25'),
        api.getPage<TemporaryPassSummary>('/temporary-passes?status=active&limit=25'),
      ]);

      setPending(pendingResult.items);
      setApproved(approvedResult.items);
      setTemporary(temporaryResult.items);
      setFailed(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    api
      .get<Gate[]>('/gates')
      .then((result) => {
        setGates(result);
        // Same key the scanner uses: an officer picks their gate once a shift.
        const remembered = localStorage.getItem('gateId');
        const usable = result.find((gate) => gate.id === remembered) ?? result[0];
        if (usable) setGateId(usable.id);
      })
      .catch(() => toast.error('Could not load gates.'));
  }, []);

  useEffect(() => {
    if (gateId) localStorage.setItem('gateId', gateId);
  }, [gateId]);

  useEffect(() => {
    let cancelled = false;
    let first = true;

    async function run() {
      const ok = await load();
      // A dropped poll on a gate tablet is routine. Only the first failure,
      // when nothing is on screen yet, is worth interrupting the officer for.
      if (!ok && first && !cancelled) setFailed(true);
      first = false;
    }

    void run();
    const timer = setInterval(() => void run(), REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Passes desk</h1>
        <select
          value={gateId}
          onChange={(event) => setGateId(event.target.value)}
          aria-label="Gate"
          className="border-input bg-background h-10 rounded-md border px-3 text-sm"
        >
          {gates.length === 0 && <option value="">No gates configured</option>}
          {gates.map((gate) => (
            <option key={gate.id} value={gate.id}>
              {gate.code} — {gate.name}
            </option>
          ))}
        </select>
      </div>

      <VerifyCard
        gateId={gateId}
        verification={verification}
        onVerified={setVerification}
        onActed={() => void load()}
        onOpenTemporary={setDetailId}
      />

      <Card>
        <CardHeader>
          <CardTitle>Exit passes awaiting approval</CardTitle>
        </CardHeader>
        <CardContent>
          {pending === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : pending.length === 0 ? (
            <EmptyState
              icon={<Clock aria-hidden />}
              title="Nothing awaiting approval"
              description="Removals raised by residents appear here for a supervisor to approve. If you are not an approver, this list stays empty — verify by code instead."
            />
          ) : (
            <ul className="divide-border divide-y">
              {pending.map((pass) => (
                <PendingRow key={pass.id} pass={pass} onDecided={() => void load()} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approved and ready at the gate</CardTitle>
        </CardHeader>
        <CardContent>
          {approved === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : approved.length === 0 ? (
            <EmptyState
              icon={<PackageCheck aria-hidden />}
              title="No approved removals"
              description="An approved exit pass is single-use: it closes the moment the goods leave."
            />
          ) : (
            <ul className="divide-border divide-y">
              {approved.map((pass) => (
                <li key={pass.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{pass.carrierName}</span>
                    <p className="text-muted-foreground text-xs">
                      → {pass.destination} · {pass.totalQuantity}{' '}
                      {pass.totalQuantity === 1 ? 'item' : 'items'}
                    </p>
                  </div>
                  <Badge tone="success" size="sm" dot>
                    approved
                  </Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    until {formatWhen(pass.validUntil)}
                  </span>
                  <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs font-semibold tracking-wider">
                    {pass.code}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Repeat className="size-4" aria-hidden />
            Active temporary passes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {temporary === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : temporary.length === 0 ? (
            <EmptyState
              title="No active temporary passes"
              description="A temporary pass stays usable for its whole window — contractors come and go on the same code."
            />
          ) : (
            <ul className="divide-border divide-y">
              {temporary.map((pass) => (
                <li key={pass.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setDetailId(pass.id)}
                      className="text-left font-medium underline-offset-4 hover:underline"
                    >
                      {pass.holderName}
                    </button>
                    <p className="text-muted-foreground text-xs">
                      {pass.company ? `${pass.company} · ` : ''}
                      {pass.purpose}
                    </p>
                  </div>
                  <Badge tone={pass.inside ? 'info' : 'neutral'} size="sm" dot>
                    {pass.inside ? 'inside' : 'outside'}
                  </Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {pass.useCount} {pass.useCount === 1 ? 'passage' : 'passages'} · until{' '}
                    {formatWhen(pass.validUntil)}
                  </span>
                  <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs font-semibold tracking-wider">
                    {pass.code}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {detailId && (
        <TemporaryPassDetailDialog
          passId={detailId}
          canRevoke={canRevoke}
          onClose={() => setDetailId(null)}
          onRevoked={() => {
            // A verification on screen for the same pass is now out of date.
            if (verification?.kind === 'temporary' && verification.result.pass?.id === detailId) {
              setVerification(null);
            }
            void load();
          }}
        />
      )}
    </div>
  );
}

function VerifyCard({
  gateId,
  verification,
  onVerified,
  onActed,
  onOpenTemporary,
}: {
  gateId: string;
  verification: Verification | null;
  onVerified: (result: Verification | null) => void;
  onActed: () => void;
  onOpenTemporary: (passId: string) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 4) return;

    setBusy(true);
    try {
      // The holder does not say which kind of pass they have, so both are
      // asked. `settled` rather than `all`: one endpoint the role cannot reach
      // must not hide the answer from the other.
      const [exit, temporary] = await Promise.allSettled([
        api.post<ExitVerification>('/exit-passes/verify', { code: trimmed }),
        api.post<TemporaryVerification>('/temporary-passes/verify', { code: trimmed }),
      ]);

      if (exit.status === 'fulfilled' && exit.value.pass) {
        onVerified({ kind: 'exit', result: exit.value });
      } else if (temporary.status === 'fulfilled' && temporary.value.pass) {
        onVerified({ kind: 'temporary', result: temporary.value });
      } else if (exit.status === 'rejected' && temporary.status === 'rejected') {
        const reason = exit.reason;
        toast.error(
          reason instanceof ApiRequestError ? reason.message : 'Could not reach the server.',
        );
        onVerified(null);
      } else {
        onVerified({ kind: 'unknown', code: trimmed });
      }

      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="size-4" aria-hidden />
          Verify a pass
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={verify} className="flex flex-wrap items-end gap-2">
          <Input
            label="Pass code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            maxLength={12}
            minLength={4}
            autoComplete="off"
            className="font-mono tracking-[0.18em] uppercase"
            hint="Exit or temporary — both are checked"
          />
          <Button type="submit" loading={busy} className="shrink-0">
            Check
          </Button>
        </form>

        {verification?.kind === 'unknown' && (
          <Alert tone="danger">
            No pass on this estate has the code{' '}
            <span className="font-mono font-semibold">{verification.code}</span>.
          </Alert>
        )}

        {verification?.kind === 'exit' && (
          <ExitVerificationPanel
            result={verification.result}
            gateId={gateId}
            onClosed={() => {
              onVerified(null);
              onActed();
            }}
          />
        )}

        {verification?.kind === 'temporary' && (
          <TemporaryVerificationPanel
            result={verification.result}
            gateId={gateId}
            onRecorded={(updated) => {
              onVerified({ kind: 'temporary', result: updated });
              onActed();
            }}
            onOpenDetail={onOpenTemporary}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * An exit pass at the barrier.
 *
 * The manifest renders whether or not the pass is usable — that is the whole
 * reason the endpoint returns it on a refusal, and an officer who cannot say
 * what was declared cannot explain why the boxes are staying.
 */
function ExitVerificationPanel({
  result,
  gateId,
  onClosed,
}: {
  result: ExitVerification;
  gateId: string;
  onClosed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const pass = result.pass;
  if (!pass) return null;

  async function close() {
    if (!pass) return;
    if (!gateId) {
      toast.error('Choose a gate first.');
      return;
    }

    setBusy(true);
    try {
      await api.post(
        `/exit-passes/${pass.id}/close`,
        { gateId },
        // A retry after a timeout must not read as a second removal.
        { idempotencyKey: `exit-close-${pass.id}` },
      );
      toast.success(`Pass ${pass.code} closed. The goods are recorded as gone.`);
      onClosed();
    } catch (caught) {
      toast.error(caught instanceof ApiRequestError ? caught.message : 'Could not close the pass.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg p-4',
        result.usable ? 'bg-success-muted' : 'bg-danger-muted',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.usable ? 'success' : 'danger'} dot>
          {result.usable ? 'Valid' : 'Do not release'}
        </Badge>
        <Badge tone="neutral" size="sm">
          exit pass · single use
        </Badge>
        <span className="text-foreground flex-1 text-sm font-medium">{result.message}</span>
      </div>

      <div className="text-foreground text-sm">
        <p className="font-medium">{pass.carrierName}</p>
        <p className="text-muted-foreground text-xs">
          → {pass.destination} · {pass.reason}
          {pass.vehiclePlate ? ` · ${pass.vehiclePlate}` : ''}
          {pass.carrierPhone ? ` · ${pass.carrierPhone}` : ''}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {pass.status} · valid until {formatWhen(pass.validUntil)}
        </p>
      </div>

      <div className="bg-background/60 rounded-md p-3">
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          Declared manifest — check the load against this
        </p>
        <ul className="divide-border divide-y text-sm">
          {pass.items.map((item, index) => (
            <li key={`${item.description}-${index}`} className="flex flex-wrap gap-2 py-1.5">
              <span className="w-10 shrink-0 font-semibold tabular-nums">×{item.quantity}</span>
              <span className="min-w-0 flex-1">
                {item.description}
                {item.identifyingMark && (
                  <span className="text-muted-foreground block text-xs">
                    Mark: {item.identifyingMark}
                  </span>
                )}
              </span>
              {item.estimatedValue !== null && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatMoney(item.estimatedValue)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {result.usable && (
        <ConfirmDialog
          trigger={
            <Button block loading={busy}>
              <ArrowUpRight aria-hidden />
              Goods have left — close pass
            </Button>
          }
          title={`Close pass ${pass.code}?`}
          description="This records the removal at this gate and spends the pass. It is single-use: the code will not open the barrier again, and nothing can reopen it."
          confirmLabel="Close pass"
          cancelLabel="Not yet"
          onConfirm={close}
        />
      )}
    </div>
  );
}

/**
 * A temporary pass at the barrier.
 *
 * Deliberately offers direction rather than "use": the pass is reusable within
 * its window and has no spent state, so the only thing a passage changes is the
 * count and whether the holder is inside.
 */
function TemporaryVerificationPanel({
  result,
  gateId,
  onRecorded,
  onOpenDetail,
}: {
  result: TemporaryVerification;
  gateId: string;
  onRecorded: (updated: TemporaryVerification) => void;
  onOpenDetail: (passId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pass = result.pass;
  if (!pass) return null;

  async function record(direction: 'in' | 'out') {
    if (!pass) return;
    if (!gateId) {
      toast.error('Choose a gate first.');
      return;
    }

    setBusy(true);
    try {
      const updated = await api.post<{ useCount: number; inside: boolean; status: string }>(
        `/temporary-passes/${pass.id}/use`,
        { gateId, direction },
      );

      toast.success(direction === 'in' ? 'Entry recorded' : 'Exit recorded');
      onRecorded({
        ...result,
        message: updated.inside ? 'Valid. Currently inside.' : 'Valid. Admit.',
        pass: {
          ...pass,
          useCount: updated.useCount,
          inside: updated.inside,
          status: updated.status,
        },
      });
    } catch (caught) {
      toast.error(
        caught instanceof ApiRequestError ? caught.message : 'Could not record the passage.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg p-4',
        result.usable ? 'bg-success-muted' : 'bg-danger-muted',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.usable ? 'success' : 'danger'} dot>
          {result.usable ? 'Valid' : 'Do not admit'}
        </Badge>
        <Badge tone="neutral" size="sm">
          temporary pass · reusable
        </Badge>
        <span className="text-foreground flex-1 text-sm font-medium">{result.message}</span>
      </div>

      <div className="text-foreground text-sm">
        <p className="font-medium">{pass.holderName}</p>
        <p className="text-muted-foreground text-xs">
          {pass.company ? `${pass.company} · ` : ''}
          {pass.purpose}
          {pass.vehiclePlate ? ` · ${pass.vehiclePlate}` : ''}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {pass.useCount} {pass.useCount === 1 ? 'passage' : 'passages'} so far · good until{' '}
          {formatWhen(pass.validUntil)}
        </p>
        <Button
          size="sm"
          variant="link"
          className="h-auto px-0"
          onClick={() => onOpenDetail(pass.id)}
        >
          Full record{pass.status === 'active' ? ' and revoke' : ''}
        </Button>
      </div>

      {result.usable && (
        <div className="flex flex-wrap gap-2">
          <Button
            className="flex-1"
            loading={busy}
            disabled={pass.inside}
            onClick={() => void record('in')}
          >
            <ArrowDownLeft aria-hidden />
            Record entry
          </Button>
          <Button
            className="flex-1"
            variant="secondary"
            loading={busy}
            disabled={!pass.inside}
            onClick={() => void record('out')}
          >
            <ArrowUpRight aria-hidden />
            Record exit
          </Button>
        </div>
      )}

      {result.usable && (
        <p className="text-muted-foreground text-xs">
          Recording a passage does not spend this pass — it stays valid until{' '}
          {formatWhen(pass.validUntil)} however many times it is used.
        </p>
      )}
    </div>
  );
}

function PendingRow({ pass, onDecided }: { pass: ExitPassSummary; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  async function decide(approved: boolean) {
    setBusy(true);
    try {
      const result = await api.post<{ status: string; token: string | null }>(
        `/exit-passes/${pass.id}/approve`,
        { approved, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      );

      if (approved) {
        // The token is returned once, here. It is held in state only while the
        // row is open and never written to storage.
        setIssuedToken(result.token);
        toast.success(`Pass ${pass.code} approved. The manifest is now locked.`);
      } else {
        toast.success(`Pass ${pass.code} refused.`);
        onDecided();
      }
    } catch (caught) {
      toast.error(caught instanceof ApiRequestError ? caught.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{pass.carrierName}</span>
          <p className="text-muted-foreground text-xs">
            → {pass.destination} · {pass.reason}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {pass.itemCount} {pass.itemCount === 1 ? 'line' : 'lines'} · {pass.totalQuantity}{' '}
            {pass.totalQuantity === 1 ? 'item' : 'items'} · expires {formatWhen(pass.validUntil)}
          </p>
        </div>
        <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs font-semibold tracking-wider">
          {pass.code}
        </code>
      </div>

      {issuedToken ? (
        <Alert tone="success">
          Approved. The manifest is locked and cannot be amended by anyone — a correction means
          cancelling this pass and raising a new one. Give the carrier the code{' '}
          <span className="font-mono font-semibold">{pass.code}</span>; the gate reads the pass by
          it.
        </Alert>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            label="Note or reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            hint="Required in practice for a refusal — the resident sees it"
          />
          <ConfirmDialog
            trigger={
              <Button size="sm" loading={busy}>
                <Check aria-hidden />
                Approve
              </Button>
            }
            title={`Approve pass ${pass.code}?`}
            description="This issues the gate credential and locks the manifest permanently. Nobody can amend the list afterwards, including you."
            confirmLabel="Approve"
            cancelLabel="Back"
            onConfirm={() => decide(true)}
          />
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="outline" loading={busy}>
                <X aria-hidden />
                Refuse
              </Button>
            }
            title={`Refuse pass ${pass.code}?`}
            description="The resident is told it was refused, with your reason. They can raise a new pass."
            confirmLabel="Refuse"
            cancelLabel="Back"
            tone="danger"
            onConfirm={() => decide(false)}
          />
        </div>
      )}
    </li>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Minor units in, naira out. */
function formatMoney(minorUnits: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}
