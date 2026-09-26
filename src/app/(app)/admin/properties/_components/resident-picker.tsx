'use client';

import { useEffect, useId, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonText } from '@/components/ui/skeleton';
import { api } from '@/lib/api/client';

/**
 * Picks a resident by name and hands back their membership id.
 *
 * The id is never typed by hand: it is an opaque object id, and a mistyped one
 * attaches a car or a tenancy to a stranger. The search is the same one the
 * incident assign dialog uses — active members, ten at a time — and the chosen
 * person is shown by name with a way to clear it, so what is about to be
 * submitted is always on screen.
 */
export interface ResidentOption {
  membershipId: string;
  fullName: string;
  category: string;
  unitNumber: string | null;
}

export function ResidentPicker({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: ResidentOption | null;
  onChange: (next: ResidentOption | null) => void;
}) {
  const listId = useId();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ResidentOption[] | null>(null);

  useEffect(() => {
    if (value) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ status: 'active', limit: '10' });
      if (term.trim()) query.set('search', term.trim());

      api
        .get<ResidentOption[]>(`/residents?${query.toString()}`)
        .then((items) => {
          if (!cancelled) setResults(items);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, value]);

  if (value) {
    return (
      <div className="space-y-1.5">
        <span className="text-foreground block text-sm font-medium">{label}</span>
        <div className="border-input flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{value.fullName}</span>
          <Badge tone="neutral" size="sm">
            {value.category}
          </Badge>
          {value.unitNumber && (
            <span className="text-muted-foreground text-xs">{value.unitNumber}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(null);
              setTerm('');
            }}
            aria-label={`Clear ${value.fullName}`}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Input
        label={label}
        hint={hint}
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Name or resident code"
        leadingIcon={<Search aria-hidden />}
        autoComplete="off"
        aria-controls={listId}
      />

      <ul id={listId} className="divide-border max-h-52 divide-y overflow-y-auto rounded-md border">
        {results === null ? (
          <li className="p-3">
            <SkeletonText lines={2} />
          </li>
        ) : results.length === 0 ? (
          <li className="text-muted-foreground p-3 text-sm">Nobody matches that.</li>
        ) : (
          results.map((person) => (
            <li key={person.membershipId}>
              <button
                type="button"
                onClick={() => onChange(person)}
                className="hover:bg-accent focus-visible:ring-ring flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {person.fullName}
                </span>
                <Badge tone="neutral" size="sm">
                  {person.category}
                </Badge>
                {person.unitNumber && (
                  <span className="text-muted-foreground text-xs">{person.unitNumber}</span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
