'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { ApiRequestError, api } from '@/lib/api/client';

/**
 * Suspending and deleting a resident.
 *
 * Two different tools, and the card says which is which. Suspension takes
 * access away from someone who is still here — the service revokes their own
 * gate pass and the credential on every vehicle registered to them, because a
 * membership marked suspended with a live credential behind it still opens the
 * barrier. Deletion removes the record from the estate and is refused while a
 * tenancy or vehicle still depends on it; the refusal names what is in the way,
 * and is shown verbatim so the administrator knows what to end first.
 *
 * Both take a reason, required by the API and recorded in the audit trail.
 */
const REASON_MIN = 3;

export function AccountActions({
  membershipId,
  fullName,
  status,
  onChanged,
}: {
  membershipId: string;
  fullName: string;
  status: string;
  onChanged: () => Promise<void> | void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const reasonReady = trimmed.length >= REASON_MIN;
  const suspended = status === 'suspended';

  async function suspend() {
    setError(null);
    try {
      await api.post(
        `/residents/${membershipId}/suspend`,
        { reason: trimmed },
        { idempotencyKey: crypto.randomUUID() },
      );
      toast.success(`${fullName} suspended`, {
        description: 'Their gate pass and vehicle credentials have been revoked.',
      });
      setReason('');
      await onChanged();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not suspend this resident.',
      );
    }
  }

  async function remove() {
    setError(null);
    try {
      await api.delete(`/residents/${membershipId}?reason=${encodeURIComponent(trimmed)}`, {
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(`${fullName} removed from the estate`);
      router.push('/admin/residents');
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not delete this resident.',
      );
    }
  }

  return (
    <Card className="border-danger/40">
      <CardHeader>
        <CardTitle>Access and removal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          label="Reason"
          hint="Required for either action and recorded against your account in the audit trail."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          minLength={REASON_MIN}
          maxLength={500}
          autoComplete="off"
        />

        <div className="flex flex-wrap gap-2">
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={suspended || !reasonReady}>
                {suspended ? 'Suspended' : 'Suspend'}
              </Button>
            }
            title={`Suspend ${fullName}?`}
            description={`Their membership is suspended and their gate pass, plus the credential on every vehicle registered to them, is revoked immediately. Their record, invoices and history stay. Reason recorded: "${trimmed}"`}
            confirmLabel="Suspend and revoke access"
            tone="danger"
            onConfirm={suspend}
          />

          <ConfirmDialog
            trigger={
              <Button variant="danger" disabled={!reasonReady}>
                Delete
              </Button>
            }
            title={`Delete ${fullName}?`}
            description={`They are removed from the estate and any remaining gate credentials are revoked. Their audit, gate and invoice history is kept. This is refused while they still hold a tenancy or a registered vehicle — suspend instead if they are still here. Reason recorded: "${trimmed}"`}
            confirmLabel="Delete resident"
            tone="danger"
            confirmPhrase={fullName}
            onConfirm={remove}
          />
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
      </CardContent>
    </Card>
  );
}
