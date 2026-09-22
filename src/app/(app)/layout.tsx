import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { decodeJwt } from 'jose';
import { ACCESS_COOKIE } from '@/core/http';
import { AppShell } from '@/components/layout/app-shell';

/**
 * Authenticated shell.
 *
 * The cookie is *decoded* here, not verified: this is a rendering decision
 * about which navigation to show, and the API verifies the signature on every
 * request it serves. Treating a decoded claim as proof of anything would be a
 * mistake; using it to avoid rendering a menu the user cannot use is not.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;

  if (!token) redirect('/login');

  let claims: { sub?: string; roles?: string[]; perms?: string[]; exp?: number };
  try {
    claims = decodeJwt(token);
  } catch {
    redirect('/login');
  }

  // An expired token still renders the shell; the first API call refreshes it,
  // and bouncing to login on a stale-by-seconds cookie would sign people out
  // mid-task for no benefit.
  return (
    <AppShell
      permissions={claims.perms ?? []}
      user={{
        name: 'Signed in',
        role: claims.roles?.[0]?.replace(/-/g, ' ') ?? 'Resident',
        estateName: 'Estate',
      }}
    >
      {children}
    </AppShell>
  );
}
