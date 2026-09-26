'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiRequestError } from '@/lib/api/client';

interface Verified {
  reference: string;
  status: 'pending' | 'successful' | 'failed';
  amount: number;
  currency: string;
  paidAt: string | null;
}

type Outcome =
  | { kind: 'checking' }
  | { kind: 'verified'; payment: Verified }
  | { kind: 'error'; message: string; retryable: boolean };

/**
 * Where Paystack sends the resident after checkout.
 *
 * The query string is the payer's to edit, so nothing here trusts it: the
 * reference only names which payment to ask about, and the answer comes from
 * the server re-verifying with the provider. Settlement itself does not depend
 * on this page at all — the signed webhook settles the invoice whether or not
 * the browser ever arrives.
 */
function Callback() {
  const params = useSearchParams();
  // Paystack appends both; they carry the same value.
  const reference = params.get('reference') ?? params.get('trxref');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'checking' });

  const check = useCallback(async () => {
    if (!reference) {
      setOutcome({
        kind: 'error',
        message: 'This link has no payment reference, so there is nothing to check.',
        retryable: false,
      });
      return;
    }

    setOutcome({ kind: 'checking' });

    try {
      const payment = await api.get<Verified>(
        `/payments/verify?reference=${encodeURIComponent(reference)}`,
      );
      setOutcome({ kind: 'verified', payment });
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 404) {
        setOutcome({
          kind: 'error',
          message: 'We could not find a payment with that reference.',
          retryable: false,
        });
      } else if (caught instanceof ApiRequestError && caught.status === 422) {
        // An amount mismatch: flagged for review server-side, not retryable.
        setOutcome({ kind: 'error', message: caught.message, retryable: false });
      } else {
        setOutcome({
          kind: 'error',
          message:
            'We could not confirm the payment just now. If you were charged, it will still be applied once the provider confirms it.',
          retryable: true,
        });
      }
    }
  }, [reference]);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {outcome.kind === 'checking' && (
          <Alert tone="info">Confirming your payment with the provider…</Alert>
        )}

        {outcome.kind === 'verified' && <Result payment={outcome.payment} />}

        {outcome.kind === 'error' && (
          <Alert
            tone="warning"
            action={
              outcome.retryable ? (
                <Button size="sm" variant="outline" onClick={() => void check()}>
                  Try again
                </Button>
              ) : undefined
            }
          >
            {outcome.message}
          </Alert>
        )}

        <Button asChild variant={outcome.kind === 'verified' ? 'primary' : 'outline'}>
          <Link href="/my/payments">Back to my payments</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Result({ payment }: { payment: Verified }) {
  const amount = formatMoney(payment.amount, payment.currency);

  if (payment.status === 'successful') {
    return (
      <Alert tone="success" title="Payment received">
        {amount} was paid
        {payment.paidAt ? ` on ${formatDate(payment.paidAt)}` : ''}. Reference{' '}
        <span className="font-mono">{payment.reference}</span>.
      </Alert>
    );
  }

  if (payment.status === 'failed') {
    return (
      <Alert tone="danger" title="Payment not completed">
        The payment of {amount} did not go through. You can try again from your payments.
      </Alert>
    );
  }

  return (
    <Alert tone="info" title="Payment processing">
      The provider has not confirmed the payment of {amount} yet. Your invoice will update on its
      own once it does.
    </Alert>
  );
}

export default function PaymentCallbackPage() {
  return (
    <Suspense fallback={null}>
      <Callback />
    </Suspense>
  );
}

function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
