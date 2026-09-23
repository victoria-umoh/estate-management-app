'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ShieldX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { SkeletonTable } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The gate movement log.
 *
 * A supervisor reads this to find refusals, not to admire the traffic, so a
 * denied entry carries the reason on the row itself and is tinted; admissions
 * stay quiet. The denied count for the page in hand is stated at the top so a
 * clean shift can be recognised without reading every line.
 *
 * `admitted` is filtered by the API, but there is no `direction` parameter, so
 * direction is applied to the page already fetched. That keeps the page size
 * honest — it is what the server returned — at the cost of a direction filter
 * that thins a page rather than re-querying.
 */
interface Movement {
  id: string;
  direction: 'in' | 'out';
  subject: string;
  label: string;
  unitNumber: string | null;
  vehiclePlate: string | null;
  admitted: boolean;
  denialReason: string | null;
  method: string;
  occurredAt: string;
}

const PAGE_SIZE = 50;

export default function GateActivityPage() {
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [admitted, setAdmitted] = useState<'all' | 'admitted' | 'denied'>('all');
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (admitted !== 'all') params.set('admitted', admitted === 'admitted' ? 'true' : 'false');

    try {
      setMovements(await api.get<Movement[]>(`/security/activity?${params.toString()}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [page, admitted]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const visible =
    movements?.filter((movement) => direction === 'all' || movement.direction === direction) ?? [];
  const denied = visible.filter((movement) => !movement.admitted).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Gate activity</h1>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4 pt-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">Outcome</span>
            {(['all', 'admitted', 'denied'] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={admitted === option ? 'primary' : 'ghost'}
                onClick={() => {
                  setAdmitted(option);
                  setPage(1);
                }}
              >
                {option}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">Direction</span>
            {(['all', 'in', 'out'] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={direction === option ? 'primary' : 'ghost'}
                onClick={() => setDirection(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {denied > 0 && (
        <Card className="border-danger">
          <CardContent className="flex items-center gap-3 p-4 pt-4">
            <ShieldX className="text-danger size-5 shrink-0" aria-hidden />
            <p className="text-sm">
              <span className="text-danger font-semibold tabular-nums">{denied}</span> refused on
              this page.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Movements</CardTitle>
        </CardHeader>
        <CardContent>
          {movements === null ? (
            <SkeletonTable rows={8} columns={4} />
          ) : visible.length === 0 ? (
            <EmptyState
              variant={admitted !== 'all' || direction !== 'all' ? 'no-results' : 'empty'}
              title={
                admitted !== 'all' || direction !== 'all'
                  ? 'Nothing matches those filters'
                  : 'No movements logged'
              }
              description="Every scan, plate read and manual decision at a gate is recorded here."
            />
          ) : (
            <ul className="divide-border divide-y">
              {visible.map((movement) => (
                <li
                  key={movement.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 py-2.5 text-sm',
                    !movement.admitted && 'bg-danger-muted -mx-2 rounded-lg px-2',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-full',
                      movement.admitted
                        ? 'bg-success-muted text-success'
                        : 'bg-danger-muted text-danger',
                    )}
                    aria-hidden
                  >
                    {movement.direction === 'in' ? (
                      <ArrowDownLeft className="size-3.5" />
                    ) : (
                      <ArrowUpRight className="size-3.5" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1 truncate font-medium">
                    {movement.label}
                    <span className="sr-only"> {movement.direction === 'in' ? 'in' : 'out'}</span>
                  </span>

                  {movement.unitNumber && (
                    <span className="text-muted-foreground text-xs">{movement.unitNumber}</span>
                  )}
                  {movement.vehiclePlate && (
                    <span className="text-muted-foreground font-mono text-xs">
                      {movement.vehiclePlate}
                    </span>
                  )}

                  <Badge tone="neutral" size="sm">
                    {movement.subject}
                  </Badge>
                  <Badge tone="neutral" size="sm">
                    {movement.method}
                  </Badge>

                  {!movement.admitted && (
                    <Badge tone="danger" size="sm">
                      {movement.denialReason ?? 'denied'}
                    </Badge>
                  )}

                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {formatStamp(movement.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {movements !== null && (page > 1 || movements.length === PAGE_SIZE) && (
        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground text-sm tabular-nums">Page {page}</span>
          <Button
            variant="outline"
            disabled={movements.length < PAGE_SIZE}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return today
    ? time
    : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
