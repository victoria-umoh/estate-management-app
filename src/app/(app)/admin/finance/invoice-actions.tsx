'use client';

import { useState } from 'react';
import { Ban, Banknote, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { ApiRequestError, api } from '@/lib/api/client';
import { formatMoney, minorToInput, parseMoney } from './money';

/**
 * What can be done to one invoice, offered only when it can be done.
 *
 * The status rules mirror the service rather than inventing their own: issue
 * only a draft, cancel only before any money has arrived, and take a payment
 * only on something that has actually been billed. The server refuses the rest
 * anyway; hiding them means nobody learns the rules by being told no.
 */
export interface InvoiceRow {
  id: string;
  number: string;
  membershipId: string;
  status: string;
  total: number;
  amountPaid: number;
  outstanding: number;
}

export interface InvoicePermissions {
  issue: boolean;
  cancel: boolean;
  recordPayment: boolean;
}

const BILLED = new Set(['issued', 'partially-paid', 'overdue']);

export function InvoiceActions({
  invoice,
  permissions,
  onChanged,
}: {
  invoice: InvoiceRow;
  permissions: InvoicePermissions;
  onChanged: () => void;
}) {
  const canIssue = permissions.issue && invoice.status === 'draft';
  const canCancel =
    permissions.cancel && invoice.status !== 'cancelled' && invoice.amountPaid === 0;
  const canPay = permissions.recordPayment && BILLED.has(invoice.status) && invoice.outstanding > 0;

  if (!canIssue && !canCancel && !canPay) return null;

  async function issue() {
    try {
      // Keyed on the invoice: issuing is a one-way transition, so any retry of
      // it — a double tap, a timeout — is the same request.
      await api.post(`/invoices/${invoice.id}/issue`, undefined, {
        idempotencyKey: `invoice-issue-${invoice.id}`,
      });
      toast.success(`${invoice.number} issued. ${formatMoney(invoice.total, true)} is now owed.`);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiRequestError ? caught.message : 'Could not issue it.');
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {canIssue && (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline">
              <Send aria-hidden />
              Issue
            </Button>
          }
          title={`Issue ${invoice.number}?`}
          description={`This posts ${formatMoney(invoice.total, true)} to the ledger as owed by the resident and tells them. It cannot be taken back to a draft — correcting it afterwards means cancelling it, which the resident also sees.`}
          confirmLabel="Issue invoice"
          onConfirm={issue}
        />
      )}
      {canPay && <ManualPaymentDialog invoice={invoice} onRecorded={onChanged} />}
      {canCancel && <CancelInvoiceDialog invoice={invoice} onCancelled={onChanged} />}
    </div>
  );
}

/**
 * Cancel, with a reason the API insists on.
 *
 * Not the shared ConfirmDialog because the reason is part of the request, not
 * a formality in front of it: it is what someone reads a year later when asking
 * why a debt disappeared.
 */
function CancelInvoiceDialog({
  invoice,
  onCancelled,
}: {
  invoice: InvoiceRow;
  onCancelled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issued = invoice.status !== 'draft';

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/invoices/${invoice.id}/cancel`, { reason: reason.trim() });
      toast.success(`${invoice.number} cancelled.`);
      setOpen(false);
      setReason('');
      onCancelled();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not cancel it.');
    } finally {
      setSubmitting(false);
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
        <Button size="sm" variant="ghost" className="text-danger">
          <Ban aria-hidden />
          Cancel
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {invoice.number}?</DialogTitle>
          <DialogDescription>
            {issued
              ? `The ${formatMoney(invoice.total, true)} debt is reversed in the ledger and the resident no longer owes it. This cannot be undone — billing them again means a new invoice.`
              : 'The draft is withdrawn and can never be issued. This cannot be undone.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            label="Reason"
            required
            value={reason}
            maxLength={500}
            placeholder="Raised against the wrong unit"
            hint="Recorded in the audit trail"
            onChange={(event) => setReason(event.target.value)}
          />
          {error && <Alert tone="danger">{error}</Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Keep invoice
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={submitting}
              disabled={reason.trim().length < 4}
            >
              Cancel invoice
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Record cash or a bank transfer taken outside the payment provider.
 *
 * This credits an account on the recorder's word alone, so the note is
 * mandatory and should say how the money arrived. The idempotency key belongs
 * to the exact submission: it is renewed whenever the amount or note changes,
 * and kept when the same form is resent after a timeout — so a retry cannot
 * credit the resident twice, and a corrected amount is not mistaken for one.
 */
function ManualPaymentDialog({
  invoice,
  onRecorded,
}: {
  invoice: InvoiceRow;
  onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<'Cash' | 'Bank transfer'>('Bank transfer');
  const [amount, setAmount] = useState(() => minorToInput(invoice.outstanding));
  const [note, setNote] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minor = parseMoney(amount);
  const tooMuch = minor !== null && minor > invoice.outstanding;
  const fullNote = `${method}: ${note.trim()}`;
  const valid = minor !== null && minor > 0 && !tooMuch && note.trim().length >= 4;

  // A changed form is a different request, so it gets a different key.
  function renewKey() {
    setKey(crypto.randomUUID());
  }

  function reset() {
    setMethod('Bank transfer');
    setAmount(minorToInput(invoice.outstanding));
    setNote('');
    setError(null);
    renewKey();
  }

  async function submit() {
    if (!valid || minor === null) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.post(
        '/payments/manual',
        {
          invoiceId: invoice.id,
          membershipId: invoice.membershipId,
          amount: minor,
          note: fullNote,
        },
        { idempotencyKey: key },
      );
      toast.success(`${formatMoney(minor, true)} recorded against ${invoice.number}.`);
      reset();
      setOpen(false);
      onRecorded();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not record it.');
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
          <Banknote aria-hidden />
          Record payment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record a payment on {invoice.number}</DialogTitle>
          <DialogDescription>
            For money received outside online checkout. It is credited immediately, cannot be edited
            afterwards, and is recorded under your name.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend className="text-foreground mb-1.5 text-sm font-medium">Received by</legend>
            <div className="bg-muted flex rounded-md p-0.5" role="group">
              {(['Bank transfer', 'Cash'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={method === option}
                  onClick={() => {
                    setMethod(option);
                    renewKey();
                  }}
                  className={
                    method === option
                      ? 'bg-background text-foreground shadow-subtle h-9 flex-1 rounded text-sm font-medium'
                      : 'text-muted-foreground h-9 flex-1 rounded text-sm font-medium'
                  }
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>

          <Input
            label="Amount (₦)"
            required
            inputMode="decimal"
            value={amount}
            hint={`${formatMoney(invoice.outstanding, true)} outstanding`}
            error={
              amount && minor === null
                ? 'Enter an amount like 50000 or 1250.50'
                : tooMuch
                  ? 'More than is outstanding'
                  : undefined
            }
            onChange={(event) => {
              setAmount(event.target.value);
              renewKey();
            }}
          />

          <Input
            label={method === 'Cash' ? 'Receipt or who received it' : 'Transfer reference'}
            required
            value={note}
            maxLength={480}
            placeholder={
              method === 'Cash' ? 'Receipt 0042, taken by estate office' : 'GTB 0012345678'
            }
            onChange={(event) => {
              setNote(event.target.value);
              renewKey();
            }}
          />

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!valid}>
              Record {minor !== null && minor > 0 ? formatMoney(minor, true) : 'payment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
