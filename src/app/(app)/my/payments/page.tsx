'use client';

import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Receipt } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';

/**
 * A resident's dues.
 *
 * Paying opens the provider's checkout and then stops. This page never marks an
 * invoice paid: the browser coming back from a redirect proves nothing, since
 * the payer controls that URL. The invoice flips only when the webhook lands
 * and the amount has been re-verified against the provider — so an invoice that
 * still reads "due" straight after paying is the system being careful, not
 * broken, and the copy says so rather than leaving the resident to guess.
 */
interface Invoice {
  id: string;
  number: string;
  status: string;
  total: number;
  amountPaid: number;
  outstanding: number;
  dueAt: string;
  issuedAt: string | null;
}

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  issued: 'warning',
  'partially-paid': 'warning',
  paid: 'success',
  overdue: 'danger',
  cancelled: 'neutral',
};

export default function MyPaymentsPage() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // No membership id is sent: the server resolves it from the session, so
      // this page cannot be pointed at another household's dues.
      const result = await api.get<Invoice[]>('/me/invoices?limit=50');
      setInvoices(result);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pay(invoice: Invoice) {
    setPaying(invoice.id);
    setProblem(null);

    try {
      const { authorizationUrl } = await api.post<{
        authorizationUrl: string;
        reference: string;
      }>('/me/invoices', { invoiceId: invoice.id });

      window.location.href = authorizationUrl;
    } catch {
      setProblem('Could not start the payment. Please try again.');
      setPaying(null);
    }
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const outstanding = invoices?.reduce((total, invoice) => total + invoice.outstanding, 0) ?? 0;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">My payments</h1>

      {problem && <Alert tone="danger">{problem}</Alert>}

      <Card>
        <CardContent className="flex items-center gap-3 p-4 pt-4">
          <span className="bg-muted text-muted-foreground grid size-10 shrink-0 place-items-center rounded-lg">
            <Receipt className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-2xl leading-none font-semibold tabular-nums">
              {invoices === null ? '—' : formatMoney(outstanding)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">Currently outstanding</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices === null ? (
            <SkeletonTable rows={4} columns={3} />
          ) : invoices.length === 0 ? (
            <EmptyState
              title="Nothing owed"
              description="Invoices for estate dues will appear here."
            />
          ) : (
            <ul className="divide-border divide-y">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap items-center gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{invoice.number}</span>
                      <Badge tone={TONE[invoice.status] ?? 'neutral'} size="sm" dot>
                        {invoice.status}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Due {formatDate(invoice.dueAt)}
                    </p>
                  </div>

                  <span className="font-medium tabular-nums">{formatMoney(invoice.total)}</span>

                  {invoice.outstanding > 0 && invoice.status !== 'cancelled' && (
                    <Button
                      size="sm"
                      disabled={paying === invoice.id}
                      onClick={() => void pay(invoice)}
                    >
                      <CreditCard aria-hidden />
                      {paying === invoice.id ? 'Opening…' : 'Pay'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="text-muted-foreground mt-4 text-xs">
            An invoice is marked paid once the payment is confirmed with the provider, which can
            take a few moments after checkout.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function formatMoney(minorUnits: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
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
