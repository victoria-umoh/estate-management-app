import { AuthorizationError } from '@/core/errors';
import type { RequestContext } from '@/core/tenancy';
import type { Permission } from './permissions';

/**
 * Authorisation checks.
 *
 * Every check is against the permission set resolved at login and carried in
 * the access token. The UI hides what a user cannot do; these functions are
 * what make that true rather than cosmetic.
 */

export const WILDCARD = '*';

/** True when the context holds the permission, or the super-admin wildcard. */
export function can(context: RequestContext, permission: Permission | string): boolean {
  return context.permissions.has(WILDCARD) || context.permissions.has(permission);
}

/** True when the context holds every listed permission. */
export function canAll(context: RequestContext, permissions: readonly string[]): boolean {
  return permissions.every((permission) => can(context, permission));
}

/** True when the context holds at least one of the listed permissions. */
export function canAny(context: RequestContext, permissions: readonly string[]): boolean {
  return permissions.some((permission) => can(context, permission));
}

/**
 * Throw unless the permission is held.
 *
 * The message names the missing permission. That is intentional: the caller is
 * already authenticated, the permission names are not secret, and a vague
 * "forbidden" turns every support conversation into guesswork.
 */
export function assertCan(context: RequestContext, permission: Permission | string): void {
  if (!can(context, permission)) {
    throw new AuthorizationError(`This action requires the "${permission}" permission.`);
  }
}

export function assertCanAll(context: RequestContext, permissions: readonly string[]): void {
  for (const permission of permissions) assertCan(context, permission);
}

/**
 * Guard a cross-estate operation.
 *
 * Separate from `can()` because platform permissions reach beyond the tenant
 * boundary the rest of the system enforces. Requiring both the flag and the
 * permission means a mis-seeded role alone cannot open that door.
 */
export function assertPlatformAccess(context: RequestContext, permission: Permission): void {
  if (!context.isPlatformAdmin) {
    throw new AuthorizationError('This action is restricted to platform administrators.');
  }
  assertCan(context, permission);
}

/**
 * Whether an actor may grant a role of the given rank.
 *
 * Strictly less than, not less-than-or-equal: a manager must not be able to
 * grant another manager role and so clone their own authority sideways, and
 * nobody may grant a role above themselves.
 */
export function canGrantRank(actorHighestRank: number, targetRank: number): boolean {
  return targetRank < actorHighestRank;
}
