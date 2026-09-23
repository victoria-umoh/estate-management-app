'use client';

import { useCallback, useEffect, useState } from 'react';
import { Banknote, CheckCircle2, Clock, ShieldAlert, TrendingUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The finance desk.
 *
 * Led by the trial balance, because it is the one figure that says whether
 * everything below it can be trusted. If `balanced` reads false, a posting got
 * through that should not have and every total on the page is suspect — so it
 * is stated plainly rather than buried in a report nobody opens.
 */
interface Invoice {
  id: string;
  number: string;
  membershipId: string;
  status: string;
  total: number;
  amountPaid: number;
  outstanding: number;
  currency: string;
  dueAt: string;
  issuedAt: string | null;
}

interface LedgerView {
  balances: Record<string, number>;
  balanced: boolean;
  debits: number;
  credits: number;
}

interface Fee {
  id: string;
  code: string;
  name: string;
  amount: number;
  frequency: string;
  basis: string;
  active: boolean;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  issued: 'warning',
  'partially-paid': 'warning',
  paid: 'success',
  overdue: 'danger',
  cancelled: 'neutral',
};

export default function FinancePage() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [fees, setFees] = useState<Fee[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [invoiceResult, ledgerResult, feeResult] = await Promise.all([
        api.getPage<Invoice>('/invoices?limit=25'),
        api.get<LedgerView>('/ledger'),
        api.get<Fee[]>('/fees'),
      ]);

      setInvoices(invoiceResult.items);
      setLedger(ledgerResult);
      setFees(feeResult);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const receivable = ledger?.balances['accounts-receivable'] ?? 0;
  const collected = ledger?.balances.cash ?? 0;
  const revenue = ledger?.balances.revenue ?? 0;
  const fees_ = ledger?.balances['payment-fees'] ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Finance</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {/* --- Integrity: the figure that validates every other figure -------- */}
      {ledger && !ledger.balanced && (
        <Card className="border-danger">
          <CardContent className="flex items-start gap-3 p-4 pt-4">
            <ShieldAlert className="text-danger mt-0.5 size-5 shrink-0" aria-hidden />
            <div>
              <p className="text-danger font-medium">The ledger does not balance</p>
              <p className="text-muted-foreground mt-1 text-sm tabular-nums">
                Debits {formatMoney(ledger.debits)} against credits {formatMoney(ledger.credits)}.
                Treat every total on this page as unverified until this is resolved.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* --- Headline figures ---------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={<Clock aria-hidden />}
          label="Outstanding"
          value={ledger ? formatMoney(receivable) : null}
          tone={receivable > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          icon={<Banknote aria-hidden />}
          label="Collected"
          value={ledger ? formatMoney(collected) : null}
          tone="success"
        />
        <StatTile
          icon={<TrendingUp aria-hidden />}
          label="Billed"
          value={ledger ? formatMoney(revenue) : null}
        />
        <StatTile
          icon={<CheckCircle2 aria-hidden />}
          label="Provider fees"
          value={ledger ? formatMoney(fees_) : null}
        />
      </div>

      {/* --- Invoices ------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices === null ? (
            <SkeletonTable rows={5} columns={4} />
          ) : invoices.length === 0 ? (
            <EmptyState
              title="No invoices yet"
              description="Run the billing job, or raise one against a fee category."
            />
          ) : (
            <ul className="divide-border divide-y">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                  <span className="font-mono text-xs">{invoice.number}</span>

                  <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'} size="sm" dot>
                    {invoice.status}
                  </Badge>

                  <span className="flex-1" />

                  {invoice.outstanding > 0 && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatMoney(invoice.outstanding)} due
                    </span>
                  )}

                  <span className="w-24 text-right font-medium tabular-nums">
                    {formatMoney(invoice.total)}
                  </span>

                  <span className="text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums">
                    {formatDate(invoice.dueAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- Fee categories -------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Fees</CardTitle>
        </CardHeader>
        <CardContent>
          {fees === null ? (
            <SkeletonTable rows={3} columns={3} />
          ) : fees.length === 0 ? (
            <EmptyState
              title="No fees configured"
              description="A fee category is what the billing run charges against."
            />
          ) : (
            <ul className="divide-border divide-y">
              {fees.map((fee) => (
                <li key={fee.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                  <span className="font-medium">{fee.name}</span>
                  <Badge tone="neutral" size="sm">
                    {fee.frequency}
                  </Badge>
                  <span className="text-muted-foreground text-xs">per {fee.basis}</span>
                  <span className="flex-1" />
                  <span className="font-medium tabular-nums">{formatMoney(fee.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  tone?: 'neutral' | 'success' | 'warning';
}) {
  return (
    <Card className={cn(tone === 'warning' && 'border-warning')}>
      <CardContent className="flex items-center gap-3 p-4 pt-4">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
            tone === 'neutral' && 'bg-muted text-muted-foreground',
            tone === 'success' && 'bg-success-muted text-success',
            tone === 'warning' && 'bg-warning-muted text-warning',
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xl leading-none font-semibold tabular-nums">{value ?? '—'}</p>
          <p className="text-muted-foreground mt-1 truncate text-xs">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Minor units in, naira out. Division happens here and nowhere near the data. */
function formatMoney(minorUnits: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
