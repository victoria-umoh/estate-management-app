'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The one and only sight of a vehicle's gate credential.
 *
 * Only the token's hash is stored, so this is rendered from state and never
 * persisted: close it and the token is gone, and the remedy is to verify the
 * vehicle again, which issues a new one and retires this. Same contract as a
 * visitor pass receipt, and the same QR settings so the gate scanner reads both.
 */
export function CredentialReceipt({
  plateNumber,
  token,
  reason,
  onDismiss,
}: {
  plateNumber: string;
  token: string;
  /** Why a credential was issued — shown as the card's title. */
  reason: string;
  onDismiss: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
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

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast.success('Credential copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.');
    }
  }

  return (
    <Card className="border-success">
      <CardHeader>
        <CardTitle className="text-success flex items-center gap-2">
          <KeyRound className="size-5" aria-hidden />
          {reason}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr}
              alt={`Gate credential QR for ${plateNumber}`}
              className="size-40 shrink-0 rounded-lg bg-white p-2"
            />
          )}
          <Alert tone="warning" className="flex-1" title="Shown once">
            This credential cannot be retrieved again. Hand it to the owner now — print the QR or
            send it to them. If it is lost, verify the vehicle again to issue a replacement; the old
            one stops working at that moment.
          </Alert>
        </div>

        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">Token</span>
          <div className="flex items-start gap-2">
            <code className="bg-muted min-w-0 flex-1 rounded-md p-2 font-mono text-[11px] break-all select-all">
              {token}
            </code>
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <Button variant="outline" block onClick={onDismiss}>
          Done — discard the credential
        </Button>
      </CardContent>
    </Card>
  );
}
