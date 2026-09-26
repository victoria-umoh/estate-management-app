'use client';

import { useState } from 'react';
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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * Record a refusal the officer made on their own judgement.
 *
 * Loaded on demand from the scanner, so the dialog code costs nothing until an
 * officer actually turns someone away. A refused QR or visitor-code scan is
 * logged by the scan itself and never reaches here; this is for the cases the
 * system cannot see — someone with no pass at all, a plate that was only looked
 * up, or a valid pass the officer still would not honour.
 *
 * It writes an entry-refused record at the gate under the officer's name and
 * an audit entry. Neither can be edited afterwards, which the dialog says
 * before the button rather than after.
 */
const REASONS = [
  'No valid pass',
  'Host did not confirm',
  'Refused identity check',
  'Vehicle not registered',
  'Conduct at the gate',
] as const;

export default function DenyEntryDialog({
  gateId,
  gateLabel,
  subject,
  onClose,
  onRecorded,
}: {
  gateId: string;
  gateLabel: string;
  /** Prefilled from the scan result when there is one. */
  subject: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [label, setLabel] = useState(subject);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = label.trim().length >= 2 && reason.trim().length >= 2;

  async function submit() {
    if (!valid) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.post('/gate/deny', {
        gateId,
        label: label.trim(),
        reason: reason.trim(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success(`Refusal recorded at ${gateLabel}.`);
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([80, 60, 80]);
      }
      onRecorded();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Deny entry</DialogTitle>
          <DialogDescription>
            Logs a refused entry at {gateLabel} under your name. It cannot be edited or removed
            afterwards.
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
            label="Who or what"
            required
            value={label}
            maxLength={160}
            placeholder="Name, company or plate"
            onChange={(event) => setLabel(event.target.value)}
            className="h-11"
          />

          <fieldset>
            <legend className="text-foreground mb-1.5 text-sm font-medium">Reason</legend>
            <div className="flex flex-wrap gap-1.5">
              {REASONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={reason === option}
                  onClick={() => setReason(option)}
                  className={cn(
                    'min-h-10 rounded-full border px-3 py-1.5 text-sm transition-colors',
                    reason === option
                      ? 'border-danger bg-danger-muted text-danger font-medium'
                      : 'border-input text-muted-foreground hover:bg-accent',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
            <Input
              aria-label="Other reason"
              className="mt-2 h-11"
              value={REASONS.includes(reason as (typeof REASONS)[number]) ? '' : reason}
              maxLength={120}
              placeholder="Or type a reason"
              onChange={(event) => setReason(event.target.value)}
            />
          </fieldset>

          <Input
            label="Notes (optional)"
            value={notes}
            maxLength={1000}
            onChange={(event) => setNotes(event.target.value)}
            className="h-11"
          />

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" size="lg" variant="outline" onClick={onClose}>
              Back
            </Button>
            <Button type="submit" size="lg" variant="danger" loading={submitting} disabled={!valid}>
              Record refusal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
