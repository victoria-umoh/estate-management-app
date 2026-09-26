import { redirect } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { viewer } from '@/lib/viewer';

/**
 * Authenticated shell.
 *
 * The viewer comes from the *decoded* cookie — a rendering decision about which
 * navigation to show; the API verifies the signature on every request it
 * serves. An expired token still renders the shell: the first API call
 * refreshes it, and bouncing to login on a stale-by-seconds cookie would sign
 * people out mid-task for no benefit.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await viewer();
  if (!me) redirect('/login');

  return (
    <AppShell
      permissions={me.permissions}
      user={{
        name: 'Signed in',
        role: me.roles[0]?.replace(/-/g, ' ') ?? 'Resident',
        estateName: me.isPlatformAdmin ? 'Platform' : 'Estate',
      }}
    >
      {children}
    </AppShell>
  );
}
