'use client';

import { useCallback, useEffect, useState } from 'react';
import { DoorOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { SkeletonText } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * The estate's gates.
 *
 * The list endpoint returns the summary only, so editing loads the gate itself
 * first: description and operating hours are not in the list, and a form that
 * opened with them blank would clear them on save. Only changed fields are
 * sent, for the same reason as the settings form above.
 *
 * A viewer without gate access sees nothing here rather than an error — the
 * card is one section of a wider page, not the page itself.
 */
type GateStatus = 'open' | 'closed' | 'maintenance';
type GateDirection = 'both' | 'entry-only' | 'exit-only';

interface GateSummary {
  id: string;
  name: string;
  code: string;
  status: GateStatus;
  direction: GateDirection;
}

interface GateDetail extends GateSummary {
  description: string | null;
  opensAt: string | null;
  closesAt: string | null;
}

const DIRECTIONS: GateDirection[] = ['both', 'entry-only', 'exit-only'];
const STATUSES: GateStatus[] = ['open', 'closed', 'maintenance'];

const STATUS_TONE: Record<GateStatus, 'success' | 'neutral' | 'warning'> = {
  open: 'success',
  closed: 'neutral',
  maintenance: 'warning',
};

const SELECT_CLASS =
  'border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm capitalize focus-visible:ring-2 focus-visible:outline-none';

export function GatesCard() {
  const [gates, setGates] = useState<GateSummary[] | null>(null);
  const [state, setState] = useState<'ready' | 'hidden' | 'failed'>('ready');

  const load = useCallback(async () => {
    try {
      setGates(await api.get<GateSummary[]>('/gates'));
      setState('ready');
    } catch (caught) {
      setState(caught instanceof ApiRequestError && caught.status === 403 ? 'hidden' : 'failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'hidden') return null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <DoorOpen className="size-4" aria-hidden />
            Gates
          </CardTitle>
          <CardDescription>
            Every scan and movement is recorded against a gate. A closed or under-maintenance gate
            refuses scans.
          </CardDescription>
        </div>
        {state === 'ready' && <GateFormDialog onSaved={load} />}
      </CardHeader>
      <CardContent>
        {state === 'failed' ? (
          <ErrorState
            title="The gates could not be loaded"
            description="The settings above are unaffected."
            onRetry={() => void load()}
          />
        ) : gates === null ? (
          <SkeletonText lines={3} />
        ) : gates.length === 0 ? (
          <EmptyState
            title="No gates yet"
            description="Add the estate's gates so officers can scan passes at them."
          />
        ) : (
          <ul className="divide-border divide-y">
            {gates.map((gate) => (
              <li key={gate.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="font-mono text-sm font-semibold tracking-wide">{gate.code}</span>
                <span className="min-w-0 flex-1 basis-32 truncate text-sm">{gate.name}</span>
                <Badge tone="neutral" size="sm">
                  {gate.direction.replace(/-/g, ' ')}
                </Badge>
                <Badge tone={STATUS_TONE[gate.status]} dot size="sm">
                  {gate.status}
                </Badge>
                <GateFormDialog gate={gate} onSaved={load} />
                <RemoveGateDialog gate={gate} onRemoved={load} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Create a gate, or edit one when `gate` is given.
 *
 * Status and operating hours are edit-only: the API opens every new gate and
 * gives it no hours, and offering them on create would be an input it drops.
 */
function GateFormDialog({ gate, onSaved }: { gate?: GateSummary; onSaved: () => Promise<void> }) {
  const editing = gate !== undefined;

  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<GateDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [direction, setDirection] = useState<GateDirection>('both');
  const [status, setStatus] = useState<GateStatus>('open');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');

  function fill(detail: GateDetail | null) {
    setName(detail?.name ?? '');
    setCode(detail?.code ?? '');
    setDescription(detail?.description ?? '');
    setDirection(detail?.direction ?? 'both');
    setStatus(detail?.status ?? 'open');
    setOpensAt(detail?.opensAt ?? '');
    setClosesAt(detail?.closesAt ?? '');
  }

  async function openDialog(next: boolean) {
    setOpen(next);
    setError(null);
    setLoadError(null);
    if (!next) return;

    if (!editing) {
      setOriginal(null);
      fill(null);
      return;
    }

    setOriginal(null);
    try {
      const detail = await api.get<GateDetail>(`/gates/${gate.id}`);
      setOriginal(detail);
      fill(detail);
    } catch (caught) {
      setLoadError(caught instanceof ApiRequestError ? caught.message : 'Could not load the gate.');
    }
  }

  // Both ends or neither: one bound on its own reads as a gate that never
  // opens, or never closes, and neither is what anyone means.
  const hoursInvalid = Boolean(opensAt) !== Boolean(closesAt);
  const valid = name.trim().length >= 2 && code.trim().length >= 2 && !hoursInvalid;

  function buildPatch(detail: GateDetail): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (name.trim() !== detail.name) patch.name = name.trim();
    if (code.trim().toUpperCase() !== detail.code) patch.code = code.trim();
    if (description.trim() !== (detail.description ?? '')) {
      patch.description = description.trim() || null;
    }
    if (direction !== detail.direction) patch.direction = direction;
    if (status !== detail.status) patch.status = status;
    if (opensAt !== (detail.opensAt ?? '')) patch.opensAt = opensAt || null;
    if (closesAt !== (detail.closesAt ?? '')) patch.closesAt = closesAt || null;
    return patch;
  }

  const dirty = editing ? original !== null && Object.keys(buildPatch(original)).length > 0 : true;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (editing) {
        if (!original) return;
        await api.patch(`/gates/${original.id}`, buildPatch(original));
      } else {
        await api.post('/gates', {
          name: name.trim(),
          code: code.trim(),
          direction,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      }
      setOpen(false);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'The gate was not saved.');
    } finally {
      setBusy(false);
    }
  }

  const closing = editing && original?.status === 'open' && status !== 'open';

  return (
    <Dialog open={open} onOpenChange={(next) => void openDialog(next)}>
      <DialogTrigger asChild>
        {editing ? (
          <Button variant="ghost" size="sm" aria-label={`Edit ${gate.name}`}>
            <Pencil aria-hidden />
            Edit
          </Button>
        ) : (
          <Button size="sm">
            <Plus aria-hidden />
            Add gate
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${gate.name}` : 'Add a gate'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Past movements keep pointing at this gate whatever you change here.'
              : 'New gates open straight away, in both directions unless you say otherwise.'}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <Alert tone="danger">{loadError}</Alert>
        ) : editing && original === null ? (
          <SkeletonText lines={5} />
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <Input
                label="Name"
                required
                minLength={2}
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Main Gate"
              />
              <Input
                label="Code"
                required
                minLength={2}
                maxLength={12}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="MAIN"
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
              />
            </div>

            <Input
              label="Description"
              maxLength={400}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional — where it is, what it serves"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-foreground block text-sm font-medium">Direction</span>
                <select
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as GateDirection)}
                  className={SELECT_CLASS}
                >
                  {DIRECTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/-/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>

              {editing && (
                <label className="block space-y-1.5">
                  <span className="text-foreground block text-sm font-medium">Status</span>
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value as GateStatus)}
                    className={SELECT_CLASS}
                  >
                    {STATUSES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {editing && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Opens at"
                  type="time"
                  value={opensAt}
                  onChange={(event) => setOpensAt(event.target.value)}
                  hint="24-hour, estate time. Leave both blank for always open."
                />
                <Input
                  label="Closes at"
                  type="time"
                  value={closesAt}
                  onChange={(event) => setClosesAt(event.target.value)}
                  error={hoursInvalid ? 'Set both times, or neither.' : undefined}
                />
              </div>
            )}

            {closing && (
              <Alert tone="warning" title={`Scans at ${original?.code} will be refused`}>
                Officers on this gate will be unable to admit or let out anyone until it is opened
                again.
              </Alert>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!valid || !dirty}>
                {editing ? 'Save changes' : 'Add gate'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Remove a gate.
 *
 * The API refuses a gate that has recorded a movement today, and says so; the
 * description tells the person to close it first so that refusal is expected
 * rather than surprising. The reason is typed before the confirm step.
 */
function RemoveGateDialog({
  gate,
  onRemoved,
}: {
  gate: GateSummary;
  onRemoved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setError(null);
    try {
      await api.delete(
        `/gates/${gate.id}?${new URLSearchParams({ reason: reason.trim() }).toString()}`,
        { idempotencyKey: crypto.randomUUID() },
      );
      setOpen(false);
      setReason('');
      await onRemoved();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'The gate was not removed.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason('');
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Remove ${gate.name}`}>
          <Trash2 aria-hidden />
          Remove
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {gate.name}</DialogTitle>
          <DialogDescription>
            A gate that has recorded movements today cannot be removed — close it and remove it once
            the shift has ended. Past movements keep resolving to it.
          </DialogDescription>
        </DialogHeader>

        <Input
          label="Reason"
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Decommissioned, merged with another gate…"
          error={error ?? undefined}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <ConfirmDialog
            trigger={
              <Button variant="danger" disabled={reason.trim().length < 3}>
                Remove gate
              </Button>
            }
            title={`Remove gate ${gate.code}?`}
            description={`${gate.name} disappears from the officer's gate list and nothing more can be scanned at it. There is no way to restore it from the app.`}
            confirmLabel="Remove"
            tone="danger"
            confirmPhrase={gate.code}
            onConfirm={remove}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
