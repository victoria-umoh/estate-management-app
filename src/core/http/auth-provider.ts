import { AuthenticationError } from '@/core/errors';
import type { RequestContext } from '@/core/tenancy';

/**
 * Seam between the HTTP kernel and authentication.
 *
 * The kernel must not depend on the auth module directly — auth needs the
 * kernel's errors and context types, and a direct import would make that
 * circular. Instead the auth module registers a resolver at startup.
 *
 * The default implementation refuses everything. That is deliberate: if
 * registration is ever missed, every authenticated route fails closed rather
 * than running with an empty context.
 */
export type ContextResolver = (request: Request) => Promise<RequestContext | null>;

let resolver: ContextResolver = async () => {
  throw new AuthenticationError('Authentication is not configured on this server.');
};

export function setContextResolver(next: ContextResolver): void {
  resolver = next;
}

export function resolveRequestContext(request: Request): Promise<RequestContext | null> {
  return resolver(request);
}
