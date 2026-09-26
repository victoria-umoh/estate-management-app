import { cookies } from 'next/headers';
import { decodeJwt } from 'jose';
import { ACCESS_COOKIE } from '@/core/http';
import { PERMISSIONS, WILDCARD } from '@/core/rbac';
import { PassesDesk } from './passes-desk';

/**
 * The passes desk, told on the server whether this viewer may revoke.
 *
 * Decoded, not verified, as the shell does for the navigation: it decides only
 * whether a button is drawn. The revoke route checks the permission itself.
 */
export default async function SecurityPassesPage() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;

  let canRevoke = false;
  try {
    const held = new Set(token ? (decodeJwt<{ perms?: string[] }>(token).perms ?? []) : []);
    canRevoke = held.has(WILDCARD) || held.has(PERMISSIONS.TEMPORARY_PASS_REVOKE);
  } catch {
    // An unreadable cookie offers no revoke; the layout deals with the session.
  }

  return <PassesDesk canRevoke={canRevoke} />;
}
