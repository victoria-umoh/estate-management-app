'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { visibleNavigation } from './navigation';

/**
 * ⌘K.
 *
 * One box for the whole estate: a resident by name or code, a plate, a pass
 * code, a ticket, an invoice number, a unit — plus the screens themselves, so
 * the palette is also the fastest way to navigate.
 *
 * The interaction follows the gate scanner's tone: typing is the only required
 * input, the keyboard alone can finish the job, and nothing moves that does not
 * have to. Arrows walk the list, Enter opens, Escape closes.
 *
 * Two things this component deliberately does NOT do:
 *
 *  - It does not decide what the viewer may see. The server returns only the
 *    result types the caller holds a permission for; the palette renders what
 *    it is given. Navigation targets are filtered through `visibleNavigation`
 *    for the same reason the sidebar is — to avoid offering a link that would
 *    403 — not as a security control.
 *  - It does not ship in the shared bundle. `app-shell` mounts it through
 *    `next/dynamic` with `ssr: false`, the same arrangement the toaster uses,
 *    so the gate scanner does not download a search palette it will never open
 *    before its first paint.
 */

/** Long enough that a fast typist fires one request, short enough to feel live. */
const DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 2;

type SearchResultType =
  | 'resident'
  | 'property'
  | 'vehicle'
  | 'visitor-pass'
  | 'service-request'
  | 'incident'
  | 'invoice'
  | 'payment';

interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  status?: string;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
}

const TYPE_LABELS: Record<SearchResultType, string> = {
  resident: 'Residents',
  property: 'Properties',
  vehicle: 'Vehicles',
  'visitor-pass': 'Visitor passes',
  incident: 'Incidents',
  'service-request': 'Service requests',
  invoice: 'Invoices',
  payment: 'Payments',
};

/** A single selectable row, flattened so one index can walk every group. */
interface Command {
  key: string;
  title: string;
  subtitle: string | null;
  href: string;
  status?: string;
}

interface CommandGroup {
  label: string;
  commands: Command[];
}

export interface CommandPaletteProps {
  /** Permissions from the access token, used to hide unusable navigation links. */
  permissions: string[];
}

export function CommandPalette({ permissions }: CommandPaletteProps) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Discards responses that arrive out of order.
   *
   * The API client takes no abort signal, so a slow request for "AB" can land
   * after a fast one for "ABC" and repopulate the list with stale rows. Each
   * request carries a sequence number and only the newest one is allowed to
   * write state.
   */
  const requestSeq = useRef(0);

  // --- Opening ---------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      // Chrome binds ⌘K to the address bar; this screen wins while it is open.
      event.preventDefault();
      setOpen((previous) => !previous);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Start clean on every open. A palette that reopens showing the last
  // search's results invites acting on a stale one.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setResults([]);
    setFailed(false);
    setActiveIndex(0);
  }, [open]);

  // --- Fetching --------------------------------------------------------------

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }

    setLoading(true);
    const seq = ++requestSeq.current;

    const timer = setTimeout(() => {
      api
        .get<SearchResponse>(`/search?q=${encodeURIComponent(trimmed)}&limit=6`)
        .then((response) => {
          if (seq !== requestSeq.current) return;
          setResults(response.results);
          setFailed(false);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setResults([]);
          setFailed(true);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmed]);

  // --- Grouping --------------------------------------------------------------

  const navigationCommands = useMemo<Command[]>(() => {
    const needle = trimmed.toLowerCase();

    return visibleNavigation(new Set(permissions))
      .flatMap((section) =>
        section.items.map((item) => ({
          key: `nav:${item.href}`,
          title: item.label,
          subtitle: section.title,
          href: item.href,
        })),
      )
      .filter((command) => !needle || command.title.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [permissions, trimmed]);

  const groups = useMemo<CommandGroup[]>(() => {
    const byType = new Map<SearchResultType, Command[]>();

    for (const result of results) {
      const command: Command = {
        key: `${result.type}:${result.id}`,
        title: result.title,
        subtitle: result.subtitle,
        href: result.href,
        ...(result.status ? { status: result.status } : {}),
      };
      byType.set(result.type, [...(byType.get(result.type) ?? []), command]);
    }

    const resultGroups = [...byType.entries()].map(([type, commands]) => ({
      label: TYPE_LABELS[type],
      commands,
    }));

    // Records first, then screens. Someone who typed a plate wants the vehicle,
    // not the vehicles page.
    return [
      ...resultGroups,
      ...(navigationCommands.length > 0 ? [{ label: 'Go to', commands: navigationCommands }] : []),
    ];
  }, [results, navigationCommands]);

  const flat = useMemo(() => groups.flatMap((group) => group.commands), [groups]);

  // Keep the highlight in range as the list changes underneath it.
  useEffect(() => setActiveIndex(0), [groups]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, groups]);

  // --- Selecting -------------------------------------------------------------

  const select = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      setOpen(false);
      router.push(command.href);
    },
    [router],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (flat.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % flat.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + flat.length) % flat.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        select(flat[activeIndex]);
      }
      // Escape is left to the dialog, which already closes and restores focus.
    },
    [flat, activeIndex, select],
  );

  // --- Render ----------------------------------------------------------------

  let index = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideClose
        className="top-[12%] max-w-xl translate-y-0 overflow-hidden p-0"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search residents, properties, vehicles, passes and records, or jump to a screen.
        </DialogDescription>

        <div className="border-border flex items-center gap-2.5 border-b px-4">
          <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search residents, plates, units, invoices…"
            aria-label="Search"
            aria-controls="command-palette-results"
            className="placeholder:text-muted-foreground h-12 flex-1 bg-transparent text-sm outline-none"
          />
          {loading && (
            <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden />
          )}
        </div>

        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          aria-label="Results"
          className="max-h-[min(24rem,60dvh)] overflow-y-auto p-2"
        >
          {groups.map((group) => (
            <div key={group.label} className="pb-1">
              <p className="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider uppercase">
                {group.label}
              </p>
              <ul>
                {group.commands.map((command) => {
                  index += 1;
                  const position = index;
                  const active = position === activeIndex;

                  return (
                    <li key={command.key}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-active={active}
                        // Follows the pointer as well as the keyboard, so the
                        // highlight never disagrees with what a click would do.
                        onMouseMove={() => setActiveIndex(position)}
                        onClick={() => select(command)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm',
                          'transition-colors duration-[120ms]',
                          active
                            ? 'bg-primary-muted text-primary'
                            : 'text-foreground hover:bg-accent',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{command.title}</span>
                        {command.subtitle && (
                          <span className="text-muted-foreground max-w-[45%] min-w-0 truncate text-xs">
                            {command.subtitle}
                          </span>
                        )}
                        {command.status && (
                          <span className="text-muted-foreground shrink-0 text-[11px] capitalize">
                            {command.status.replace(/-/g, ' ')}
                          </span>
                        )}
                        {active && (
                          <CornerDownLeft className="size-3.5 shrink-0 opacity-60" aria-hidden />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {groups.length === 0 && (
            <p className="text-muted-foreground px-2 py-6 text-center text-sm">
              {failed
                ? 'Search is unavailable right now.'
                : trimmed.length < MIN_QUERY_LENGTH
                  ? 'Type at least two characters.'
                  : loading
                    ? 'Searching…'
                    : `Nothing matches “${trimmed}”.`}
            </p>
          )}
        </div>

        <div className="border-border text-muted-foreground flex items-center gap-3 border-t px-4 py-2 text-[11px]">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
