import { cookies } from 'next/headers';
import { decodeJwt } from 'jose';
import { ACCESS_COOKIE } from '@/core/http';
import { WILDCARD } from '@/core/rbac';

/**
 * Who is looking at this server-rendered page, as the access cookie says.
 *
 * The cookie is *decoded*, not verified. That is sound only because of what it
 * is used for: deciding which menu items and buttons to draw. Every action
 * behind them calls a route that verifies the signature and the permission
 * again, so a tampered cookie buys a button that answers 403. Never use this to
 * decide what data a page may read.
 */
export interface Viewer {
  userId: string | undefined;
  roles: string[];
  permissions: string[];
  isPlatformAdmin: boolean;
  can(permission: string): boolean;
}

/** Null when there is no cookie or it cannot be read at all. */
export async function viewer(): Promise<Viewer | null> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  let claims: { sub?: string; roles?: string[]; perms?: string[]; adm?: boolean };
  try {
    claims = decodeJwt(token);
  } catch {
    return null;
  }

  const held = new Set(claims.perms ?? []);

  return {
    userId: claims.sub,
    roles: claims.roles ?? [],
    permissions: [...held],
    isPlatformAdmin: claims.adm === true,
    can: (permission) => held.has(WILDCARD) || held.has(permission),
  };
}
