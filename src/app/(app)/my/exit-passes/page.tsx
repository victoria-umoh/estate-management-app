'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lock, PackageCheck, Plus, ShieldQuestion, Trash2, TriangleAlert } from 'lucide-react';
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
import { EmptyState, ErrorState, PermissionDeniedState } from '@/components/ui/states';
import { api, ApiRequestError } from '@/lib/api/client';

/**
 * Goods leaving the estate, declared by the household they leave from.
 *
 * Two facts about the API shape the whole screen. The manifest locks the moment
 * an approver acts — there is no amend endpoint after that, by design — so no
 * edit affordance is rendered at any point; the screen instead says how a
 * mistake is actually corrected. And a pass carries no gate token until it is
 * approved, so a pending pass shows its pending state plainly rather than an
 * empty QR that looks like a scanner fault.
 *
 * `estimatedValue` has no documented unit on the API. It is read here as minor
 * units, matching every other money field in the system, so the field is
 * entered in naira and multiplied on the way out.
 */
interface ExitPassSummary {
  id: string;
  code: string;
  carrierName: string;
  destination: string;
  reason: string;
  itemCount: number;
  totalQuantity: number;
  status: string;
  approvalRequired: boolean;
  validFrom: string;
  validUntil: string;
  usedAt: string | null;
  createdAt: string;
}

interface ManifestItem {
  quantity: number;
  description: string;
  identifyingMark: string | null;
  estimatedValue: number | null;
}

interface ExitPassDetail {
  id: string;
  code: string;
  carrierName: string;
  carrierPhone: string | null;
  destination: string;
  reason: string;
  vehiclePlate: string | null;
  items: ManifestItem[];
  status: string;
  approvalRequired: boolean;
  approvedAt: string | null;
  decisionReason: string | null;
  manifestLockedAt: string | null;
  validFrom: string;
  validUntil: string;
  usedAt: string | null;
  notes: string | null;
}

interface CreatedPass {
  id: string;
  code: string;
  status: string;
  approvalRequired: boolean;
  validFrom: string;
  validUntil: string;
  items: ManifestItem[];
  /** Null until an approver acts — the estate may require approval. */
  token: string | null;
}

const PAGE_SIZE = 20;

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  used: 'neutral',
  expired: 'neutral',
  cancelled: 'neutral',
};

export default function MyExitPassesPage() {
  const [passes, setPasses] = useState<ExitPassSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [created, setCreated] = useState<CreatedPass | null>(null);

  const load = useCallback(async () => {
    try {
      // No membership id is sent: the server narrows the list to the caller's
      // own household for anyone who cannot approve, so this can only ever be
      // this resident's own removals.
      const result = await api.getPage<ExitPassSummary>(
        `/exit-passes?page=${page}&limit=${PAGE_SIZE}`,
      );
      setPasses(result.items);
      setTotal(result.meta.total);
      setHasNextPage(result.meta.hasNextPage);
      setFailed(false);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 403) setDenied(true);
      else setFailed(true);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(pass: ExitPassSummary) {
    try {
      await api.post(`/exit-passes/${pass.id}/revoke`, { reason: 'Cancelled by the resident.' });
      toast.success(`Pass ${pass.code} cancelled`);
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof ApiRequestError ? caught.message : 'Could not cancel that pass.',
      );
    }
  }

  if (denied) return <PermissionDeniedState action="raise exit passes" />;
  if (failed) return <ErrorState onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">My exit passes</h1>
        <CreatePassDialog
          onCreated={(pass) => {
            setCreated(pass);
            setPage(1);
            void load();
          }}
        />
      </div>

      <p className="text-muted-foreground max-w-prose text-sm">
        Declare anything leaving the estate — furniture, equipment, a load going for repair. The
        officer at the gate checks what is on the vehicle against the list you give here.
      </p>

      {created && <CreatedReceipt pass={created} onDismiss={() => setCreated(null)} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>Passes</span>
            {passes !== null && total > 0 && (
              <span className="text-muted-foreground text-sm font-normal tabular-nums">
                {total} total
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {passes === null ? (
            <SkeletonTable rows={4} columns={3} />
          ) : passes.length === 0 ? (
            <EmptyState
              icon={<PackageCheck aria-hidden />}
              title={page > 1 ? 'Nothing on this page' : 'No exit passes yet'}
              description="Raise one before anything of value leaves the estate, and the gate has a list to check the load against."
            />
          ) : (
            <ul className="divide-border divide-y">
              {passes.map((pass) => (
                <PassRow key={pass.id} pass={pass} onCancel={() => cancel(pass)} />
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
              disabled={passes === null || !hasNextPage}
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

/**
 * One pass, with its manifest fetched only when opened.
 *
 * The list projection carries counts rather than the items themselves, and a
 * household with fifty passes does not need fifty manifests loaded to read a
 * status.
 */
function PassRow({ pass, onCancel }: { pass: ExitPassSummary; onCancel: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ExitPassDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);

    if (next && detail === null) {
      try {
        setDetail(await api.get<ExitPassDetail>(`/exit-passes/${pass.id}`));
        setDetailFailed(false);
      } catch {
        setDetailFailed(true);
      }
    }
  }

  const cancellable = pass.status === 'pending' || pass.status === 'approved';

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{pass.carrierName}</span>
            <Badge tone={TONE[pass.status] ?? 'neutral'} size="sm" dot>
              {pass.status}
            </Badge>
            {pass.status === 'pending' && pass.approvalRequired && (
              <Badge tone="info" size="sm">
                awaiting approval
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            → {pass.destination} · {pass.reason}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">
            {pass.itemCount} {pass.itemCount === 1 ? 'line' : 'lines'} · {pass.totalQuantity}{' '}
            {pass.totalQuantity === 1 ? 'item' : 'items'} · valid until {formatWhen(pass.validUntil)}
          </p>
        </div>

        <span className="bg-muted rounded-md px-2.5 py-1 font-mono text-sm font-semibold tracking-[0.18em]">
          {pass.code}
        </span>

        <Button variant="ghost" size="sm" onClick={() => void toggle()} aria-expanded={open}>
          {open ? 'Hide' : 'Manifest'}
        </Button>

        {cancellable && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                <Trash2 aria-hidden />
                Cancel
              </Button>
            }
            title={`Cancel pass ${pass.code}?`}
            description="The code stops working at the gate immediately. The cancelled pass stays on the record, and you can raise a new one with a corrected manifest."
            confirmLabel="Cancel pass"
            cancelLabel="Keep it"
            tone="danger"
            onConfirm={onCancel}
          />
        )}
      </div>

      {open && (
        <div className="mt-3">
          {detailFailed ? (
            <Alert tone="danger">Could not load the manifest for this pass.</Alert>
          ) : detail === null ? (
            <SkeletonTable rows={2} columns={3} />
          ) : (
            <Manifest detail={detail} />
          )}
        </div>
      )}
    </li>
  );
}

function Manifest({ detail }: { detail: ExitPassDetail }) {
  return (
    <div className="bg-muted/50 space-y-3 rounded-lg p-3">
      <ul className="divide-border divide-y text-sm">
        {detail.items.map((item, index) => (
          <li key={`${item.description}-${index}`} className="flex flex-wrap gap-2 py-2">
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

      {detail.vehiclePlate && (
        <p className="text-muted-foreground text-xs">Vehicle {detail.vehiclePlate}</p>
      )}

      {detail.decisionReason && (
        <p className="text-muted-foreground text-xs">Decision note: {detail.decisionReason}</p>
      )}

      {/*
        Stated wherever the manifest is read, not only where an editor would
        have been: the point is that nobody can change it, including staff.
      */}
      {detail.manifestLockedAt ? (
        <p className="text-foreground flex items-start gap-2 text-xs">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Locked on {formatWhen(detail.manifestLockedAt)}. This list can no longer be changed, by
            you or by anyone at the estate office. If something on it is wrong, cancel this pass and
            raise a new one — both stay on the record.
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          This list locks the moment the pass is approved, and cannot be changed afterwards. Cancel
          and raise a new pass if you need to correct it.
        </p>
      )}
    </div>
  );
}

/**
 * The receipt for a pass just raised.
 *
 * An estate that requires approval returns no token, so there is deliberately
 * no QR here in that case — showing an empty frame would read as a broken
 * scanner rather than as "nobody has approved this yet".
 */
function CreatedReceipt({ pass, onDismiss }: { pass: CreatedPass; onDismiss: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const token = pass.token;

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    void (async () => {
      const { toDataURL } = await import('qrcode');
      const url = await toDataURL(token, { errorCorrectionLevel: 'M', margin: 1, width: 280 });
      if (!cancelled) setQr(url);
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Card className={token ? 'border-success' : 'border-warning'}>
      <CardHeader>
        <CardTitle className={token ? 'text-success' : 'text-warning'}>
          Pass {pass.code} raised
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {token ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt={`QR code for exit pass ${pass.code}`}
                className="size-40 shrink-0 rounded-lg bg-white p-2"
              />
            )}
            <Alert tone="warning" className="flex-1">
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  This estate does not require approval, so the pass is already valid. The QR is
                  shown once and cannot be retrieved — send it to the carrier now. The code{' '}
                  <span className="font-mono font-semibold">{pass.code}</span> works at the gate
                  either way.
                </span>
              </span>
            </Alert>
          </div>
        ) : (
          <Alert tone="info">
            <span className="flex items-start gap-2">
              <ShieldQuestion className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Waiting for an approver. There is no gate pass yet — one is issued when the estate
                office approves this removal, and until then the gate will turn the load away. Give
                the carrier the code <span className="font-mono font-semibold">{pass.code}</span>;
                it is what the officer reads the pass by once it is approved.
              </span>
            </span>
          </Alert>
        )}

        <div className="text-muted-foreground space-y-1 text-xs">
          <p className="tabular-nums">
            Valid {formatWhen(pass.validFrom)} → {formatWhen(pass.validUntil)}
          </p>
          <p>
            {pass.items.length} {pass.items.length === 1 ? 'line' : 'lines'} declared. The manifest
            locks at approval and cannot be edited afterwards.
          </p>
        </div>

        <Button variant="outline" block onClick={onDismiss}>
          Done
        </Button>
      </CardContent>
    </Card>
  );
}

interface ItemDraft {
  key: number;
  quantity: string;
  description: string;
  identifyingMark: string;
  value: string;
}

function emptyItem(key: number): ItemDraft {
  return { key, quantity: '1', description: '', identifyingMark: '', value: '' };
}

function CreatePassDialog({ onCreated }: { onCreated: (pass: CreatedPass) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem(0)]);

  function patchItem(key: number, patch: Partial<ItemDraft>) {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();

    const manifest = items
      .filter((item) => item.description.trim().length > 0)
      .map((item) => ({
        quantity: Number(item.quantity || '1'),
        description: item.description.trim(),
        ...(item.identifyingMark.trim() ? { identifyingMark: item.identifyingMark.trim() } : {}),
        // Entered in naira, sent in minor units, per the money convention.
        ...(item.value.trim() ? { estimatedValue: Math.round(Number(item.value) * 100) } : {}),
      }));

    if (manifest.length === 0) {
      setProblem('List at least one item. A pass with an empty manifest authorises anything.');
      setBusy(false);
      return;
    }

    try {
      const created = await api.post<CreatedPass>('/exit-passes', {
        carrierName: text('carrierName'),
        destination: text('destination'),
        reason: text('reason'),
        ...(text('carrierPhone') ? { carrierPhone: text('carrierPhone') } : {}),
        ...(text('vehiclePlate') ? { vehiclePlate: text('vehiclePlate') } : {}),
        ...(text('validUntil') ? { validUntil: new Date(text('validUntil')).toISOString() } : {}),
        ...(text('notes') ? { notes: text('notes') } : {}),
        items: manifest,
      });

      setOpen(false);
      setItems([emptyItem(0)]);
      onCreated(created);
    } catch (caught) {
      setProblem(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Could not raise the pass. Check the details and try again.',
      );
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

      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Declare goods leaving</DialogTitle>
          <DialogDescription>
            List everything going out. The manifest locks when the pass is approved and cannot be
            edited after that, so check it before you send it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          {problem && <Alert tone="danger">{problem}</Alert>}

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="carrierName"
              label="Who is carrying it"
              required
              minLength={2}
              maxLength={120}
            />
            <Input name="carrierPhone" label="Their phone" type="tel" maxLength={20} hint="Optional" />
          </div>

          <Input name="destination" label="Where it is going" required minLength={2} maxLength={200} />
          <Input
            name="reason"
            label="Why"
            required
            minLength={2}
            maxLength={200}
            hint="Repair, disposal, moving out — whatever the officer should be told"
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="vehiclePlate"
              label="Vehicle plate"
              maxLength={20}
              hint="Optional"
              className="uppercase"
              autoComplete="off"
            />
            <Input
              name="validUntil"
              label="Valid until"
              type="datetime-local"
              hint="Optional — defaults to 24 hours, 7 days maximum"
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-foreground text-sm font-medium">Manifest</legend>
            {items.map((item, index) => (
              <div key={item.key} className="bg-muted/50 space-y-2 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs font-medium">
                    Item {index + 1}
                  </span>
                  {items.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setItems((current) => current.filter((row) => row.key !== item.key))
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>

                <div className="grid gap-2 sm:grid-cols-[5rem_1fr]">
                  <Input
                    label="Qty"
                    type="number"
                    min={1}
                    max={10_000}
                    value={item.quantity}
                    onChange={(event) => patchItem(item.key, { quantity: event.target.value })}
                  />
                  <Input
                    label="Description"
                    maxLength={200}
                    value={item.description}
                    onChange={(event) => patchItem(item.key, { description: event.target.value })}
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    label="Identifying mark"
                    maxLength={120}
                    hint="Serial number, colour, anything that tells it apart"
                    value={item.identifyingMark}
                    onChange={(event) =>
                      patchItem(item.key, { identifyingMark: event.target.value })
                    }
                  />
                  <Input
                    label="Estimated value (₦)"
                    type="number"
                    min={0}
                    step="0.01"
                    hint="Optional"
                    value={item.value}
                    onChange={(event) => patchItem(item.key, { value: event.target.value })}
                  />
                </div>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setItems((current) => [
                  ...current,
                  emptyItem((current[current.length - 1]?.key ?? 0) + 1),
                ])
              }
            >
              <Plus aria-hidden />
              Add item
            </Button>
          </fieldset>

          <Input name="notes" label="Notes for the gate" maxLength={1000} hint="Optional" />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Raise pass
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
