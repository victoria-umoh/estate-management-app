'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, Menu, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { visibleNavigation, type NavSection } from './navigation';

/**
 * ⌘K search, loaded on demand for the same reason the toaster is: the shell is
 * on every authenticated route, so importing the palette directly would charge
 * it to the gate scanner's first paint for a dialog that screen never opens.
 */
const CommandPalette = dynamic(
  () => import('./command-palette').then((module) => module.CommandPalette),
  { ssr: false, loading: () => null },
);

export interface AppShellProps {
  children: ReactNode;
  /** Permissions from the access token, used to hide unusable links. */
  permissions: string[];
  user: { name: string; role: string; estateName: string };
  badges?: Partial<Record<string, number>>;
}

/**
 * Authenticated application shell.
 *
 * Sidebar on desktop, off-canvas drawer below `lg`. The drawer closes on
 * navigation, because leaving it open over the page someone just chose is the
 * most common mobile navigation annoyance.
 */
export function AppShell({ children, permissions, user, badges = {} }: AppShellProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sections = visibleNavigation(new Set(permissions));

  // Close the drawer whenever the route changes.
  useEffect(() => setDrawerOpen(false), [pathname]);

  // Lock background scroll while the drawer is open, so the page behind does
  // not move under the user's finger.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  return (
    <div className="bg-background min-h-dvh">
      <CommandPalette permissions={permissions} />

      {/* Desktop sidebar */}
      <aside className="border-border bg-card fixed inset-y-0 left-0 z-30 hidden w-64 border-r lg:block">
        <SidebarContent sections={sections} pathname={pathname} badges={badges} user={user} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.24, ease: [0.25, 1, 0.5, 1] }}
              className="border-border bg-card fixed inset-y-0 left-0 z-50 w-72 border-r lg:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-3 right-3"
                onClick={() => setDrawerOpen(false)}
              >
                <X aria-hidden />
                <span className="sr-only">Close navigation</span>
              </Button>
              <SidebarContent sections={sections} pathname={pathname} badges={badges} user={user} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="lg:pl-64">
        <header className="border-border bg-background/85 sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 backdrop-blur-md">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
          >
            <Menu aria-hidden />
            <span className="sr-only">Open navigation</span>
          </Button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.estateName}</p>
          </div>

          <ThemeToggle />
        </header>

        <main id="main" className="p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Ends the session server-side as well as in the browser: the logout route
 * revokes the refresh token, so a copied cookie cannot quietly mint new access.
 * A full navigation, not a client push, so no cached authenticated view of the
 * previous page survives.
 */
function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // Logging out is not worth failing: the cookies are short-lived and the
      // login page is where the user wants to be regardless.
    }
    window.location.assign('/login');
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      block
      className="text-muted-foreground mt-1 justify-start"
      disabled={busy}
      onClick={() => void signOut()}
    >
      <LogOut aria-hidden />
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}

function SidebarContent({
  sections,
  pathname,
  badges,
  user,
}: {
  sections: NavSection[];
  pathname: string;
  badges: Partial<Record<string, number>>;
  user: AppShellProps['user'];
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-5">
        <div className="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-md text-xs font-bold">
          E
        </div>
        <span className="truncate font-semibold">PrimeEstate</span>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3" aria-label="Main">
        {sections.map((section) => (
          <div key={section.title}>
            <p className="text-muted-foreground px-2 pb-1.5 text-[11px] font-semibold tracking-wider uppercase">
              {section.title}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                // Exact match for the root, prefix match elsewhere, so a nested
                // page still highlights its section.
                const active =
                  pathname === item.href ||
                  (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`));
                const count = item.badgeKey ? badges[item.badgeKey] : undefined;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors duration-[120ms]',
                        'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
                        active
                          ? 'bg-primary-muted text-primary font-medium'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <item.icon className="size-4 shrink-0" aria-hidden />
                      <span className="flex-1 truncate">{item.label}</span>
                      {count !== undefined && count > 0 && (
                        <Badge
                          tone={item.badgeKey === 'activeEmergencies' ? 'danger' : 'primary'}
                          size="sm"
                        >
                          {count > 99 ? '99+' : count}
                        </Badge>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-border shrink-0 border-t p-3">
        <Link
          href="/account"
          className="hover:bg-accent flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-[120ms]"
        >
          <div className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium">
            {user.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="text-muted-foreground truncate text-xs">{user.role}</p>
          </div>
        </Link>
        <SignOutButton />
      </div>
    </div>
  );
}
