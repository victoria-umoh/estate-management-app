'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
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
import { formatMoney, parseMoney } from './money';

/**
 * A new fee category — the thing the billing run charges against.
 *
 * Only the fields an estate sets on day one. Penalty and due day have sensible
 * server defaults, and a fee's code cannot be changed afterwards, so it is the
 * one field worth a hint.
 */
const FREQUENCIES = ['monthly', 'quarterly', 'yearly', 'one-time'] as const;
const BASES = ['property', 'resident'] as const;

const SELECT_CLASS =
  'border-input bg-background h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

export function CreateFeeDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]>('monthly');
  const [basis, setBasis] = useState<(typeof BASES)[number]>('property');
  const [dueDay, setDueDay] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minor = parseMoney(amount);
  const day = Number(dueDay);
  const valid =
    code.trim().length >= 2 &&
    name.trim().length >= 2 &&
    minor !== null &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= 28;

  function reset() {
    setCode('');
    setName('');
    setAmount('');
    setFrequency('monthly');
    setBasis('property');
    setDueDay('1');
    setError(null);
  }

  async function submit() {
    if (!valid || minor === null) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.post('/fees', {
        code: code.trim(),
        name: name.trim(),
        amount: minor,
        frequency,
        basis,
        dueDayOfMonth: day,
      });
      toast.success(`${name.trim()} added at ${formatMoney(minor, true)} ${frequency}.`);
      reset();
      setOpen(false);
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not add the fee.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus aria-hidden />
          New fee
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>New fee category</DialogTitle>
          <DialogDescription>
            Changing a fee later affects future billing only — invoices already raised keep the
            amount they were issued at.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Name"
              required
              value={name}
              maxLength={80}
              placeholder="Service charge"
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              label="Code"
              required
              value={code}
              maxLength={40}
              placeholder="service-charge"
              hint="Permanent. Lowercased on save."
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>

          <Input
            label="Amount (₦)"
            required
            inputMode="decimal"
            value={amount}
            placeholder="50,000"
            error={amount && minor === null ? 'Enter an amount like 50000 or 1250.50' : undefined}
            onChange={(event) => setAmount(event.target.value)}
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-foreground space-y-1.5 text-sm font-medium">
              <span className="block">Frequency</span>
              <select
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as typeof frequency)}
                className={SELECT_CLASS}
              >
                {FREQUENCIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-foreground space-y-1.5 text-sm font-medium">
              <span className="block">Charged per</span>
              <select
                value={basis}
                onChange={(event) => setBasis(event.target.value as typeof basis)}
                className={SELECT_CLASS}
              >
                {BASES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Due day"
              type="number"
              min={1}
              max={28}
              value={dueDay}
              hint="1–28, so every month has one"
              onChange={(event) => setDueDay(event.target.value)}
            />
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!valid}>
              Add fee
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
