'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ChangeRequestQueue } from './change-request-queue';
import { InviteResidentDialog } from './invite-resident-dialog';
import { RegistrationLinkButton } from './registration-link-button';

/**
 * The resident directory.
 *
 * Led by the approval queue rather than by the alphabet, because the only
 * reason an administrator opens this screen unprompted is that someone is
 * waiting on a decision. The queue is counted with its own request so the
 * banner stays truthful whatever filter the directory below is showing.
 *
 * Never renders a NIN, not even masked: a directory is read over shoulders and
 * screenshotted, and the value has its own audited endpoint on the detail page.
 * Change requests are the one exception, and only as the API masks them — a
 * reviewer has to see that a NIN is changing to judge the request at all.
 */
interface Resident {
  membershipId: string;
  userId: string;
  fullName: string;
  category: string;
  status: string;
  residentCode: string | null;
  unitNumber: string | null;
  photoUrl: string | null;
  verified: boolean;
  joinedAt: string;
}

const STATUSES = ['awaiting-approval', 'pending', 'active', 'suspended', 'exited'] as const;

const CATEGORIES = [
  'homeowner',
  'landlord',
  'tenant',
  'dependant',
  'family-member',
  'domestic-staff',
  'estate-staff',
  'security-personnel',
  'contractor',
  'other',
] as const;

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'info',
  'awaiting-approval': 'warning',
  active: 'success',
  suspended: 'danger',
  exited: 'neutral',
};

const PAGE_SIZE = 25;

/** The queue banner only needs an order of magnitude, so it stops counting here. */
const QUEUE_PROBE = 50;

export default function ResidentsPage() {
  const [residents, setResidents] = useState<Resident[] | null>(null);
  const [awaiting, setAwaiting] = useState<Resident[] | null>(null);
  const [failed, setFailed] = useState(false);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [page, setPage] = useState(1);

  // Typing a name should not fire a request per keystroke; the search reaches a
  // second collection server-side, so it is the most expensive query here.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (category) params.set('category', category);
    if (debouncedSearch) params.set('search', debouncedSearch);
    return params.toString();
  }, [page, status, category, debouncedSearch]);

  const load = useCallback(async () => {
    try {
      const [list, queue] = await Promise.all([
        api.get<Resident[]>(`/residents?${query}`),
        api.get<Resident[]>(`/residents?status=awaiting-approval&limit=${QUEUE_PROBE}`),
      ]);

      setResidents(list);
      setAwaiting(queue);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  // A filter change that kept the page number would land on an empty page.
  function applyFilter(next: () => void) {
    next();
    setPage(1);
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const filtered = Boolean(status || category || debouncedSearch);
  const queueCount = awaiting?.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Residents</h1>
        <div className="flex flex-wrap justify-end gap-2">
          <RegistrationLinkButton />
          <InviteResidentDialog />
        </div>
      </div>

      {queueCount > 0 && status !== 'awaiting-approval' && (
        <Card className="border-warning">
          <CardContent className="flex flex-wrap items-center gap-3 p-4 pt-4">
            <span className="bg-warning-muted text-warning grid size-9 shrink-0 place-items-center rounded-lg">
              <UserCheck className="size-4" aria-hidden />
            </span>
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium tabular-nums">
                {queueCount >= QUEUE_PROBE ? `${QUEUE_PROBE}+` : queueCount}
              </span>{' '}
              {queueCount === 1 ? 'resident is' : 'residents are'} waiting for approval.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => applyFilter(() => setStatus('awaiting-approval'))}
            >
              Review them
            </Button>
          </CardContent>
        </Card>
      )}

      {/* An approved name or unit change shows in the directory, so it reloads. */}
      <ChangeRequestQueue onReviewed={() => void load()} />

      <Card>
        <CardHeader>
          <CardTitle>Directory</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <Input
            value={search}
            onChange={(event) => applyFilter(() => setSearch(event.target.value))}
            placeholder="Name or resident code"
            aria-label="Search residents"
            leadingIcon={<Search aria-hidden />}
            autoComplete="off"
          />

          <div className="space-y-2">
            <FilterRow
              label="Status"
              options={STATUSES}
              value={status}
              onChange={(next) => applyFilter(() => setStatus(next))}
            />
            <FilterRow
              label="Category"
              options={CATEGORIES}
              value={category}
              onChange={(next) => applyFilter(() => setCategory(next))}
            />
          </div>

          {residents === null ? (
            <SkeletonTable rows={6} columns={3} />
          ) : residents.length === 0 ? (
            <EmptyState
              variant={filtered ? 'no-results' : 'empty'}
              title={filtered ? 'No residents match' : 'No residents yet'}
              description={
                filtered
                  ? 'Try a different status, category or spelling.'
                  : 'Approved registrations appear here.'
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {residents.map((resident) => (
                <li key={resident.membershipId}>
                  <Link
                    href={`/admin/residents/${resident.membershipId}`}
                    className="hover:bg-accent -mx-2 flex flex-wrap items-center gap-2 rounded-md px-2 py-2.5 transition-colors"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{resident.fullName}</span>

                    {resident.unitNumber && (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {resident.unitNumber}
                      </span>
                    )}

                    <Badge tone="neutral" size="sm">
                      {label(resident.category)}
                    </Badge>

                    <Badge
                      tone={STATUS_TONE[resident.status] ?? 'neutral'}
                      size="sm"
                      dot={resident.status === 'awaiting-approval'}
                    >
                      {label(resident.status)}
                    </Badge>

                    {resident.residentCode && (
                      <span className="text-muted-foreground font-mono text-[11px]">
                        {resident.residentCode}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* The list endpoint returns only the page, so the next button is
              offered whenever the page came back full. */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft aria-hidden />
              Previous
            </Button>

            <span className="text-muted-foreground text-xs tabular-nums">Page {page}</span>

            <Button
              variant="outline"
              size="sm"
              disabled={residents === null || residents.length < PAGE_SIZE}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FilterRow({
  label: rowLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground mr-1 text-xs font-medium">{rowLabel}</span>
      {['', ...options].map((option) => (
        <button
          key={option || 'all'}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs transition-colors',
            value === option
              ? 'border-primary bg-primary-muted text-primary font-medium'
              : 'border-input text-muted-foreground hover:bg-accent',
          )}
        >
          {option ? label(option) : 'All'}
        </button>
      ))}
    </div>
  );
}

function label(value: string): string {
  return value.replace(/-/g, ' ');
}
