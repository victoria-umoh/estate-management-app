'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ApiRequestError, api } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/**
 * The property register.
 *
 * Occupancy status leads because it is what the register is asked for: which
 * units are empty, which are let, which are unavailable. Type is a secondary
 * refinement and the list endpoint does not filter on it, so that one narrows
 * the loaded page in the browser — the label says "on this page" rather than
 * implying an estate-wide filter it cannot deliver.
 */
interface Property {
  id: string;
  unitNumber: string;
  block: string | null;
  street: string;
  type: string;
  occupancyStatus: string;
  currentOccupantCount: number;
}

const OCCUPANCY = [
  'vacant',
  'owner-occupied',
  'tenant-occupied',
  'under-construction',
  'unavailable',
] as const;

const TYPES = [
  'detached',
  'semi-detached',
  'terrace',
  'duplex',
  'bungalow',
  'apartment',
  'studio',
  'shop',
  'office',
  'land',
  'other',
] as const;

const OCCUPANCY_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  vacant: 'neutral',
  'owner-occupied': 'success',
  'tenant-occupied': 'info',
  'under-construction': 'warning',
  unavailable: 'danger',
};

const PAGE_SIZE = 25;

export default function PropertiesPage() {
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [failed, setFailed] = useState(false);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [occupancyStatus, setOccupancyStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (occupancyStatus) params.set('occupancyStatus', occupancyStatus);
    if (debouncedSearch) params.set('search', debouncedSearch);
    return params.toString();
  }, [page, occupancyStatus, debouncedSearch]);

  const load = useCallback(async () => {
    try {
      setProperties(await api.get<Property[]>(`/properties?${query}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyFilter(next: () => void) {
    next();
    setPage(1);
  }

  if (failed) return <ErrorState onRetry={() => void load()} />;

  const visible = properties && type ? properties.filter((item) => item.type === type) : properties;
  const filtered = Boolean(occupancyStatus || type || debouncedSearch);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Properties</h1>
        <AddPropertyDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Register</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <Input
            value={search}
            onChange={(event) => applyFilter(() => setSearch(event.target.value))}
            placeholder="Unit number"
            aria-label="Search by unit number"
            leadingIcon={<Search aria-hidden />}
            autoComplete="off"
          />

          <div className="space-y-2">
            <FilterRow
              label="Status"
              options={OCCUPANCY}
              value={occupancyStatus}
              onChange={(next) => applyFilter(() => setOccupancyStatus(next))}
            />
            <FilterRow
              label="Type (this page)"
              options={TYPES}
              value={type}
              onChange={(next) => setType(next)}
            />
          </div>

          {visible === null ? (
            <SkeletonTable rows={6} columns={3} />
          ) : visible.length === 0 ? (
            <EmptyState
              variant={filtered ? 'no-results' : 'empty'}
              title={filtered ? 'No properties match' : 'No properties yet'}
              description={
                filtered
                  ? 'Try a different status, type or unit number.'
                  : 'Registered units appear here.'
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {visible.map((property) => (
                <li key={property.id}>
                  <Link
                    href={`/admin/properties/${property.id}`}
                    className="hover:bg-accent -mx-2 flex flex-wrap items-center gap-2 rounded-md px-2 py-2.5 transition-colors"
                  >
                    <span className="font-medium tabular-nums">{property.unitNumber}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
                      {property.block ? `${property.block} · ` : ''}
                      {property.street}
                    </span>

                    <Badge tone="neutral" size="sm">
                      {property.type.replace(/-/g, ' ')}
                    </Badge>
                    <Badge tone={OCCUPANCY_TONE[property.occupancyStatus] ?? 'neutral'} size="sm">
                      {property.occupancyStatus.replace(/-/g, ' ')}
                    </Badge>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {property.currentOccupantCount} in
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

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
              disabled={properties === null || properties.length < PAGE_SIZE}
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

/**
 * Register a new unit.
 *
 * Every unit starts vacant — the API sets that, not the form — so there is no
 * status field here. Occupants are assigned from the property's own page, which
 * is where this sends you once the unit exists, because that is almost always
 * the next thing someone registering a unit does.
 */
function AddPropertyDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [unitNumber, setUnitNumber] = useState('');
  const [block, setBlock] = useState('');
  const [street, setStreet] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('detached');
  const [bedrooms, setBedrooms] = useState('');
  const [maxOccupants, setMaxOccupants] = useState('');
  const [notes, setNotes] = useState('');

  function reset() {
    setUnitNumber('');
    setBlock('');
    setStreet('');
    setType('detached');
    setBedrooms('');
    setMaxOccupants('');
    setNotes('');
    setError(null);
    setFieldErrors({});
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const created = await api.post<{ id: string; unitNumber: string }>('/properties', {
        unitNumber: unitNumber.trim(),
        street: street.trim(),
        type,
        // Optional fields are left out rather than sent empty: the schema
        // rejects an empty block and a bedroom count of "".
        ...(block.trim() ? { block: block.trim() } : {}),
        ...(bedrooms ? { bedrooms: Number(bedrooms) } : {}),
        ...(maxOccupants ? { maxOccupants: Number(maxOccupants) } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setOpen(false);
      reset();
      router.push(`/admin/properties/${created.id}`);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setError(caught.message);
        setFieldErrors(
          Object.fromEntries(
            (caught.details ?? [])
              .filter((detail) => detail.field)
              .map((detail) => [detail.field!.replace(/^body\./, ''), detail.message]),
          ),
        );
      } else {
        setError('The property was not registered. Try again.');
      }
    } finally {
      setBusy(false);
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
        <Button>
          <Plus aria-hidden />
          Add property
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a property</DialogTitle>
          <DialogDescription>
            The unit is registered as vacant. Owners and tenants are assigned from its page.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Unit number"
              required
              maxLength={20}
              value={unitNumber}
              onChange={(event) => setUnitNumber(event.target.value)}
              placeholder="12B"
              autoComplete="off"
              error={fieldErrors.unitNumber}
            />
            <Input
              label="Block"
              maxLength={40}
              value={block}
              onChange={(event) => setBlock(event.target.value)}
              placeholder="Optional"
              autoComplete="off"
              error={fieldErrors.block}
            />
          </div>

          <Input
            label="Street"
            required
            minLength={2}
            maxLength={120}
            value={street}
            onChange={(event) => setStreet(event.target.value)}
            autoComplete="off"
            error={fieldErrors.street}
          />

          <label className="block space-y-1.5">
            <span className="text-foreground block text-sm font-medium">Type</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value as (typeof TYPES)[number])}
              className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring h-10 w-full rounded-md border px-3 text-sm capitalize focus-visible:ring-2 focus-visible:outline-none"
            >
              {TYPES.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/-/g, ' ')}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Bedrooms"
              type="number"
              min={0}
              max={50}
              value={bedrooms}
              onChange={(event) => setBedrooms(event.target.value)}
              error={fieldErrors.bedrooms}
            />
            <Input
              label="Occupant cap"
              hint="Exceeding it is flagged, not refused."
              type="number"
              min={1}
              max={100}
              value={maxOccupants}
              onChange={(event) => setMaxOccupants(event.target.value)}
              error={fieldErrors.maxOccupants}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-foreground block text-sm font-medium" htmlFor="property-notes">
              Notes
            </label>
            <textarea
              id="property-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              maxLength={2000}
              className="border-input bg-background focus-visible:ring-ring focus-visible:border-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </div>

          {error && <Alert tone="danger">{error}</Alert>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={unitNumber.trim().length === 0 || street.trim().length < 2}
            >
              Add property
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FilterRow({
  label,
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
      <span className="text-muted-foreground mr-1 text-xs font-medium">{label}</span>
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
          {option ? option.replace(/-/g, ' ') : 'All'}
        </button>
      ))}
    </div>
  );
}
