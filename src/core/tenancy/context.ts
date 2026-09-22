import { AuthorizationError } from '@/core/errors';

/**
 * The authenticated caller, resolved once per request and threaded through
 * every service and repository call.
 *
 * `estateId` is the tenant boundary. The base repository injects it into every
 * query, so a service cannot accidentally read across estates — it has no API
 * for doing so.
 */
export interface RequestContext {
  userId: string;
  estateId: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;

  /** Correlation ID shared with logs, audit entries and background jobs. */
  correlationId: string;

  ip?: string;
  userAgent?: string;
  sessionId?: string;

  /**
   * Platform staff operating across estates. This grants NOTHING by itself:
   * cross-estate reads still require the explicitly-named PlatformRepository,
   * so they are visible in review rather than implicit.
   */
  isPlatformAdmin: boolean;
}

/**
 * The actor id used by automation.
 *
 * A real, valid ObjectId rather than the string "system", because services
 * legitimately construct an ObjectId from `context.userId` when recording who
 * did something — `issuedBy`, `recordedBy`, `approvedBy`. A non-ObjectId value
 * there crashes at the point of write, which meant every scheduled job and
 * seeder failed the moment it touched one of those fields.
 *
 * All-zero is deliberately recognisable in the database, and can never collide
 * with a generated id.
 */
export const SYSTEM_ACTOR_ID = '000000000000000000000000';

/**
 * Context for trusted, non-request work: seeders, migrations, scheduled jobs.
 *
 * Carries the `system` role so audit entries written by automation are
 * distinguishable from those written by a person.
 */
export function systemContext(estateId: string, correlationId = 'system'): RequestContext {
  return {
    userId: SYSTEM_ACTOR_ID,
    estateId,
    roles: ['system'],
    permissions: new Set(['*']),
    correlationId,
    isPlatformAdmin: true,
  };
}

/** True when the context holds the permission, or the `*` wildcard. */
export function hasPermission(context: RequestContext, permission: string): boolean {
  return context.permissions.has('*') || context.permissions.has(permission);
}

/** Throw unless the context holds the permission. */
export function assertPermission(context: RequestContext, permission: string): void {
  if (!hasPermission(context, permission)) {
    throw new AuthorizationError(`This action requires the "${permission}" permission.`);
  }
}

/**
 * Guard every repository entry point.
 *
 * A context with a blank estateId would otherwise produce `{ estateId: '' }`,
 * which matches nothing — or worse, if the field were dropped, would match
 * everything. Failing loudly is the only safe option.
 */
export function assertTenantContext(
  context: RequestContext | undefined,
): asserts context is RequestContext {
  if (!context || typeof context.estateId !== 'string' || context.estateId.trim() === '') {
    throw new AuthorizationError('A valid estate context is required for this operation.');
  }
}
