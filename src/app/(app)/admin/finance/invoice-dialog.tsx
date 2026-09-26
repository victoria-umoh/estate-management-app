'use client';

import { useEffect, useState } from 'react';
import { FilePlus2, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { ApiRequestError, api } from '@/lib/api/client';
import { formatMoney, minorToInput, parseMoney } from './money';

/**
 * Raise a one-off invoice against a resident.
 *
 * It is created as a draft and nothing more: the debt reaches the ledger only
 * when someone issues it from the list, which is a separate, confirmed step.
 * A mistyped amount on a draft costs a cancellation; on an issued invoice it
 * costs a reversing entry the resident can see.
 *
 * The resident is searched, not listed — an estate directory does not fit in a
 * dialog. Their unit is attached when the record says which one they live at,
 * so the ledger entry can be read per property later; if that lookup is not
 * allowed, the invoice is still raised against the person.
 */
export interface FeeOption {
  id: string;
  name: string;
  amount: number;
  active: boolean;
}

interface ResidentOption {
  membershipId: string;
  fullName: string;
  residentCode: string | null;
  unitNumber: string | null;
}

interface Line {
  key: string;
  feeCategoryId: string;
  description: string;
  quantity: string;
  unitAmount: string;
}

const SELECT_CLASS =
  'border-input bg-background h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

function blankLine(): Line {
  return {
    key: crypto.randomUUID(),
    feeCategoryId: '',
    description: '',
    quantity: '1',
    unitAmount: '',
  };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function CreateInvoiceDialog({
  fees,
  onCreated,
}: {
  fees: FeeOption[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [resident, setResident] = useState<ResidentOption | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<ResidentOption[]>([]);
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [dueAt, setDueAt] = useState(() => inDays(14));
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = search.trim();
    if (term.length < 2 || resident) {
      setMatches([]);
      return;
    }

    const timer = setTimeout(() => {
      api
        .get<ResidentOption[]>(
          `/residents?search=${encodeURIComponent(term)}&status=active&limit=8`,
        )
        .then(setMatches)
        .catch(() => setMatches([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [search, resident]);

  async function pick(option: ResidentOption) {
    setResident(option);
    setPropertyId(null);
    setMatches([]);

    // Best effort: without `resident.viewAll` this is a 404, and the invoice is
    // still valid against the membership alone.
    try {
      const detail = await api.get<{ property: { id: string } | null }>(
        `/residents/${option.membershipId}`,
      );
      setPropertyId(detail.property?.id ?? null);
    } catch {
      setPropertyId(null);
    }
  }

  function updateLine(key: string, changes: Partial<Line>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...changes } : line)),
    );
  }

  function chooseFee(key: string, feeId: string) {
    const fee = fees.find((option) => option.id === feeId);
    updateLine(key, {
      feeCategoryId: feeId,
      ...(fee ? { description: fee.name, unitAmount: minorToInput(fee.amount) } : {}),
    });
  }

  const parsed = lines.map((line) => ({
    line,
    quantity: Number(line.quantity),
    unit: parseMoney(line.unitAmount),
  }));
  const linesValid = parsed.every(
    ({ line, quantity, unit }) =>
      line.description.trim().length >= 2 &&
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= 1000 &&
      unit !== null,
  );
  const total = parsed.reduce((sum, { quantity, unit }) => sum + (unit ?? 0) * (quantity || 0), 0);
  const valid = resident !== null && linesValid && Boolean(dueAt);

  function reset() {
    setResident(null);
    setPropertyId(null);
    setSearch('');
    setMatches([]);
    setLines([blankLine()]);
    setDueAt(inDays(14));
    setNotes('');
    setError(null);
  }

  async function submit() {
    if (!valid || !resident) return;

    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post<{ number: string; total: number }>('/invoices', {
        membershipId: resident.membershipId,
        ...(propertyId ? { propertyId } : {}),
        lines: parsed.map(({ line, quantity, unit }) => ({
          ...(line.feeCategoryId ? { feeCategoryId: line.feeCategoryId } : {}),
          description: line.description.trim(),
          quantity,
          unitAmount: unit ?? 0,
        })),
        // End of the chosen day, local time: "due on the 10th" should still be
        // payable on the evening of the 10th.
        dueAt: new Date(`${dueAt}T23:59:59`).toISOString(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });

      toast.success(`Draft ${created.number} raised for ${formatMoney(created.total, true)}.`, {
        description: 'Issue it from the list to bill the resident.',
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not raise the invoice.');
    } finally {
      setSubmitting(false);
    }
  }

  const activeFees = fees.filter((fee) => fee.active);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <FilePlus2 aria-hidden />
          New invoice
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>
            Saved as a draft. Nothing is owed and the resident is not told until it is issued.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {/* --- Who ------------------------------------------------------- */}
          <div className="space-y-1.5">
            {resident ? (
              <>
                <p className="text-foreground text-sm font-medium">Resident</p>
                <div className="border-input flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{resident.fullName}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {[resident.residentCode, resident.unitNumber].filter(Boolean).join(' · ')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Change resident"
                    onClick={() => {
                      setResident(null);
                      setPropertyId(null);
                      setSearch('');
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Input
                  label="Resident"
                  required
                  hint="Search active residents by name or resident code"
                  leadingIcon={<Search aria-hidden />}
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {matches.length > 0 && (
                  <ul
                    className="divide-border divide-y rounded-md border"
                    aria-label="Matching residents"
                  >
                    {matches.map((match) => (
                      <li key={match.membershipId}>
                        <button
                          type="button"
                          onClick={() => void pick(match)}
                          className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                        >
                          <span className="font-medium">{match.fullName}</span>
                          <span className="text-muted-foreground truncate text-xs">
                            {[match.residentCode, match.unitNumber].filter(Boolean).join(' · ')}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {/* --- What ------------------------------------------------------ */}
          <fieldset className="space-y-3">
            <legend className="text-foreground mb-1.5 text-sm font-medium">Lines</legend>
            {lines.map((line, index) => (
              <div key={line.key} className="bg-muted/40 space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`fee-${line.key}`}>
                    Fee for line {index + 1}
                  </label>
                  <select
                    id={`fee-${line.key}`}
                    value={line.feeCategoryId}
                    onChange={(event) => chooseFee(line.key, event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="">Custom charge</option>
                    {activeFees.map((fee) => (
                      <option key={fee.id} value={fee.id}>
                        {fee.name} — {formatMoney(fee.amount)}
                      </option>
                    ))}
                  </select>
                  {lines.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() =>
                        setLines((current) => current.filter((item) => item.key !== line.key))
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_5rem_9rem]">
                  <Input
                    aria-label={`Description for line ${index + 1}`}
                    placeholder="Description"
                    value={line.description}
                    maxLength={200}
                    onChange={(event) => updateLine(line.key, { description: event.target.value })}
                  />
                  <Input
                    aria-label={`Quantity for line ${index + 1}`}
                    type="number"
                    min={1}
                    max={1000}
                    value={line.quantity}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                  />
                  <Input
                    aria-label={`Unit amount in naira for line ${index + 1}`}
                    inputMode="decimal"
                    placeholder="₦ each"
                    value={line.unitAmount}
                    error={
                      line.unitAmount && parseMoney(line.unitAmount) === null
                        ? 'Not an amount'
                        : undefined
                    }
                    onChange={(event) => updateLine(line.key, { unitAmount: event.target.value })}
                  />
                </div>
              </div>
            ))}
            {lines.length < 50 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setLines((current) => [...current, blankLine()])}
              >
                <Plus aria-hidden />
                Add line
              </Button>
            )}
          </fieldset>

          {/* --- When ------------------------------------------------------ */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Due"
              type="date"
              required
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
            <Input
              label="Note (optional)"
              value={notes}
              maxLength={1000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          <p className="text-sm">
            Total <span className="font-semibold tabular-nums">{formatMoney(total, true)}</span>
          </p>

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!valid}>
              Save draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
