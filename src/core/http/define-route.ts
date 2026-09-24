import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { config } from '@/core/config';
import { connectToDatabase } from '@/core/db';
import {
  assertFeature,
  entitlementsFor,
  type Entitlements,
  type Feature,
} from '@/core/entitlements';
import {
  AuthenticationError,
  AuthorizationError,
  PlanRestrictionError,
  ValidationError,
  normalizeError,
  serializeError,
} from '@/core/errors';
import { createLogger, withLogContext } from '@/core/logging';
import { hasPermission, type RequestContext } from '@/core/tenancy';
import { resolveRequestContext } from './auth-provider';
import { fail, ok } from './envelope';
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  fingerprintBody,
  releaseIdempotentRequest,
} from './idempotency';
import { enforceRateLimit, rateLimitHeaders, type RateLimitRule } from './rate-limit';

const log = createLogger('http');

/**
 * The estate's entitlements.
 *
 * Loaded by dynamic import so `core` keeps no compile-time dependency on
 * `modules` — the same reason the auth resolver bootstraps that way.
 */
function loadEntitlements(estateId: string): Promise<Entitlements> {
  return entitlementsFor(estateId, async () => {
    const { estateRepository } = await import('@/modules/estate');
    const estate = await estateRepository.findById(estateId);

    return estate
      ? {
          status: estate.status,
          planCode: estate.planCode ?? null,
          trialEndsAt: estate.trialEndsAt ?? null,
        }
      : null;
  });
}

/**
 * Ensure runtime seams are wired before the first request is handled.
 *
 * A dynamic import, so `core` keeps no compile-time dependency on `modules`,
 * and so this works regardless of whether instrumentation ran in the same
 * module graph as this route.
 */
let bootstrapped: Promise<void> | undefined;

function ensureBootstrapped(): Promise<void> {
  bootstrapped ??= import('@/bootstrap').then(({ bootstrap }) => bootstrap());
  return bootstrapped;
}

export interface RouteHandlerArgs<TBody, TQuery, TParams> {
  body: TBody;
  query: TQuery;
  params: TParams;
  request: Request;
}

export interface RouteDefinition<TBody, TQuery, TParams, TResult> {
  /** Omit for public routes. Anything else requires a valid session. */
  auth?: false;
  /** Every permission listed must be held. */
  permissions?: string[];
  /**
   * Input schemas.
   *
   * The third type parameter is `unknown` rather than left to default, so that
   * schemas using `.transform()` or `.default()` — where the parsed output
   * differs from the accepted input — are assignable here. Without it, any
   * schema that coerces a query string to a number or normalises a phone number
   * fails to typecheck at the route, which is precisely where those belong.
   */
  body?: z.ZodType<TBody, z.ZodTypeDef, unknown>;
  query?: z.ZodType<TQuery, z.ZodTypeDef, unknown>;
  params?: z.ZodType<TParams, z.ZodTypeDef, unknown>;
  /**
   * Plan features this route requires.
   *
   * Declared alongside the route that needs it, while the feature is being
   * built and the author knows which plan it belongs to. Retrofitting gating
   * across every route at once is how one gets missed, and a missed check is a
   * paid feature served free — with no test to catch it, because nobody writes
   * a test for a check they forgot to add.
   */
  features?: Feature[];
  /**
   * Refuse this route while the estate is in grace or suspended.
   *
   * Set on anything that writes. Reads stay open deliberately: an estate that
   * forgets to pay must not lose the gate, because residents queuing at a
   * barrier that will not open is a safety problem, not a billing one.
   */
  requiresActiveSubscription?: boolean;
  rateLimit?: RateLimitRule;
  /** Honour the `Idempotency-Key` header. Use on anything that moves money. */
  idempotent?: boolean;
  /** HTTP status for a successful response. */
  status?: number;
  handler: (
    context: RequestContext,
    args: RouteHandlerArgs<TBody, TQuery, TParams>,
  ) => Promise<TResult>;
}

type NextRouteContext<TParams> = { params: Promise<TParams> };

/** What Next calls: a request, and (on a dynamic segment) its params. */
type RouteHandler<TParams> = (
  request: Request,
  routeContext?: NextRouteContext<TParams>,
) => Promise<NextResponse>;

/**
 * Declare an API route.
 *
 * Every `/api/v1` handler goes through here, so the cross-cutting concerns are
 * applied uniformly instead of being re-implemented (and occasionally forgotten)
 * per endpoint: authentication, authorisation, input validation, rate limiting,
 * idempotency, correlation IDs, error mapping and the response envelope.
 *
 * Authorisation lives HERE, on the server, not in the UI. The UI hides what a
 * user cannot do; this is what makes it so.
 */
export function defineRoute<
  TBody = undefined,
  TQuery = undefined,
  TParams = undefined,
  TResult = unknown,
>(definition: RouteDefinition<TBody, TQuery, TParams, TResult>) {
  const routeHandler = async function routeHandler(
    request: Request,
    routeContext?: NextRouteContext<TParams>,
  ): Promise<NextResponse> {
    // Reuse an upstream correlation id when a proxy or mobile client supplies
    // one, so a trace spans the whole call chain.
    const correlationId = request.headers.get('x-correlation-id') ?? randomUUID();
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const ip = clientIp(request);

    return withLogContext({ correlationId, route, ip }, async () => {
      const startedAt = Date.now();
      let idempotencyScope:
        { userId: string; route: string; idempotencyKey: string; fingerprint: string } | undefined;

      try {
        await ensureBootstrapped();
        await connectToDatabase();

        // --- Authentication ---------------------------------------------------
        const requiresAuth = definition.auth !== false;
        // A public route must not be blocked by a stale or foreign token — an
        // expired `eos_at` cookie would otherwise 401 the very login meant to
        // replace it. Such requests proceed anonymously instead.
        const context = requiresAuth
          ? await resolveRequestContext(request)
          : await resolveRequestContext(request).catch((error: unknown) => {
              if (error instanceof AuthenticationError) return null;
              throw error;
            });

        if (requiresAuth && !context) {
          throw new AuthenticationError('You must be signed in to do that.');
        }

        // Public routes still need a context object for downstream calls; an
        // anonymous one carries no estate and no permissions, so any repository
        // call it attempts will fail closed.
        const effectiveContext: RequestContext = context ?? {
          userId: 'anonymous',
          estateId: '',
          roles: [],
          permissions: new Set(),
          correlationId,
          isPlatformAdmin: false,
          ...(ip ? { ip } : {}),
        };

        // --- Authorisation ----------------------------------------------------
        for (const permission of definition.permissions ?? []) {
          if (!hasPermission(effectiveContext, permission)) {
            // Logged so repeated denials are visible as a probing signal.
            log.warn({ permission, userId: effectiveContext.userId }, 'permission denied');
            throw new AuthorizationError(`This action requires the "${permission}" permission.`);
          }
        }

        // --- Plan entitlements ------------------------------------------------
        if (
          (definition.features?.length || definition.requiresActiveSubscription) &&
          effectiveContext.estateId
        ) {
          const entitlements = await loadEntitlements(effectiveContext.estateId);

          for (const feature of definition.features ?? []) {
            assertFeature(entitlements, feature);
          }

          if (definition.requiresActiveSubscription && entitlements.readOnly) {
            throw new PlanRestrictionError(
              'This estate\u2019s subscription is not active. Reading still works; changes are paused until it is renewed.',
            );
          }
        }

        // --- Rate limiting ----------------------------------------------------
        let limitHeaders: Record<string, string> = {};
        if (definition.rateLimit) {
          const result = await enforceRateLimit(definition.rateLimit, {
            userId: context?.userId,
            ...(ip ? { ip } : {}),
            route,
          });
          limitHeaders = rateLimitHeaders(result);
        }

        // --- Input validation -------------------------------------------------
        const rawBody = definition.body || definition.idempotent ? await readBody(request) : '';
        const body = definition.body
          ? parse(definition.body, safeJson(rawBody), 'body')
          : undefined;
        const query = definition.query
          ? parse(definition.query, queryToObject(request), 'query')
          : undefined;
        const params = definition.params
          ? parse(definition.params, await (routeContext?.params ?? Promise.resolve({})), 'params')
          : ((await routeContext?.params) as TParams);

        // --- Idempotency ------------------------------------------------------
        const idempotencyKey = request.headers.get('idempotency-key');
        if (definition.idempotent && idempotencyKey) {
          idempotencyScope = {
            userId: effectiveContext.userId,
            route,
            idempotencyKey,
            fingerprint: await fingerprintBody(rawBody),
          };

          const outcome = await beginIdempotentRequest(idempotencyScope);
          if (outcome.kind === 'replay') {
            return NextResponse.json(outcome.body, {
              status: outcome.statusCode,
              // Lets the client tell a replay from fresh work.
              headers: { ...limitHeaders, 'Idempotent-Replay': 'true' },
            });
          }
        }

        // --- Handler ----------------------------------------------------------
        const result = await definition.handler(effectiveContext, {
          body: body as TBody,
          query: query as TQuery,
          params: params as TParams,
          request,
        });

        // A handler may return a NextResponse directly when it needs to set
        // headers the envelope cannot carry — session cookies, most notably.
        // It is then responsible for its own shape.
        if (result instanceof NextResponse) {
          result.headers.set('x-correlation-id', correlationId);
          for (const [key, value] of Object.entries(limitHeaders)) {
            result.headers.set(key, value);
          }
          log.info(
            { status: result.status, durationMs: Date.now() - startedAt },
            'request completed',
          );
          return result;
        }

        const status = definition.status ?? (request.method === 'POST' ? 201 : 200);
        const payload = { success: true as const, data: result };

        if (idempotencyScope) {
          await completeIdempotentRequest(idempotencyScope, { statusCode: status, body: payload });
        }

        log.info({ status, durationMs: Date.now() - startedAt }, 'request completed');

        return NextResponse.json(payload, {
          status,
          headers: { ...limitHeaders, 'x-correlation-id': correlationId },
        });
      } catch (caught) {
        // Free the key so a transient failure does not lock the client out of
        // retrying for the full idempotency window.
        if (idempotencyScope) await releaseIdempotentRequest(idempotencyScope).catch(() => {});

        const error = normalizeError(caught);

        // Expected conditions are warnings; bugs are errors and go to Sentry.
        const logPayload = {
          err: error,
          status: error.statusCode,
          durationMs: Date.now() - startedAt,
        };
        if (error.isOperational) log.warn(logPayload, 'request failed');
        else log.error(logPayload, 'request errored');

        const headers: Record<string, string> = { 'x-correlation-id': correlationId };
        if (error.statusCode === 429 && 'retryAfterSeconds' in error) {
          headers['Retry-After'] = String(
            (error as { retryAfterSeconds: number }).retryAfterSeconds,
          );
        }

        return fail(
          serializeError(error, {
            requestId: correlationId,
            // Internal detail is shown only outside production.
            exposeInternals: !config.isProduction,
          }),
          error.statusCode,
          headers,
        );
      }
    });
  };

  /**
   * The declaration, hung off the handler.
   *
   * This is what lets the OpenAPI generator describe the API from the routes
   * themselves rather than from a document someone has to remember to update.
   * A hand-maintained spec drifts from the server within a release, and the
   * native clients this API was built for would be reading the drift.
   *
   * Non-enumerable, so it does not change what Next sees on the module.
   */
  Object.defineProperty(routeHandler, 'routeDefinition', {
    value: definition,
    enumerable: false,
  });

  // Annotated rather than `typeof routeHandler`, which would make the const's
  // type depend on the expression returning it — TypeScript resolves that
  // circularity by giving up, and the handler stops being callable.
  return routeHandler as RouteHandler<TParams> & {
    routeDefinition: RouteDefinition<TBody, TQuery, TParams, TResult>;
  };
}

// -----------------------------------------------------------------------------

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError(
    `Invalid request ${source}.`,
    result.error.issues.map((issue) => ({
      field: [source, ...issue.path.map(String)].join('.'),
      message: issue.message,
    })),
  );
}

async function readBody(request: Request): Promise<string> {
  try {
    return await request.text();
  } catch {
    return '';
  }
}

function safeJson(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body is not valid JSON.');
  }
}

function queryToObject(request: Request): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }

  return result;
}

/**
 * Best-effort client IP.
 *
 * Proxy headers are forgeable, so this is used for rate limiting and audit
 * context — never as an authorisation input.
 */
function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return request.headers.get('x-real-ip') ?? undefined;
}

export { ok };
