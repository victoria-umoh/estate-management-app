import { cookies } from 'next/headers';
import { decodeJwt } from 'jose';
import { ACCESS_COOKIE } from '@/core/http';
import { PERMISSIONS, WILDCARD } from '@/core/rbac';
import { PlatformConsole } from './platform-console';

/**
 * The platform console, told on the server whether to offer estate creation.
 *
 * Creating an estate takes both the platform-staff flag and its own permission;
 * viewing takes neither in this decision, because the console already handles
 * a refused read. Decoded, not verified — this only decides whether to draw a
 * button, and the route checks both conditions again.
 */
export default async function PlatformPage() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;

  let canCreateEstate = false;
  try {
    const claims = token ? decodeJwt<{ perms?: string[]; adm?: boolean }>(token) : null;
    const held = new Set(claims?.perms ?? []);
    canCreateEstate =
      claims?.adm === true && (held.has(WILDCARD) || held.has(PERMISSIONS.PLATFORM_ESTATE_CREATE));
  } catch {
    // An unreadable cookie offers nothing; the layout deals with the session.
  }

  return <PlatformConsole canCreateEstate={canCreateEstate} />;
}
