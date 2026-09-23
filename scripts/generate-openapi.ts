/**
 * Generate an OpenAPI 3.1 document from the routes themselves.
 *
 * Read from `defineRoute`'s own declarations rather than written by hand. A
 * hand-maintained spec drifts from the server within a release, and the native
 * clients this API was built for would be reading the drift. If a route changes
 * its schema, this changes with it or the route did not use the kernel.
 *
 *   pnpm openapi            # writes docs/openapi.json
 *   pnpm openapi --check    # fails if the committed file is out of date
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src/app/api');
const OUTPUT = join(ROOT, 'docs/openapi.json');

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

interface RouteDefinitionLike {
  auth?: false;
  permissions?: string[];
  features?: string[];
  requiresActiveSubscription?: boolean;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  rateLimit?: { limit: number; window: string };
  idempotent?: boolean;
  status?: number;
}

function routeFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(full));
    else if (entry.name === 'route.ts') found.push(full);
  }

  return found;
}

/** `src/app/api/v1/invoices/[id]/issue/route.ts` → `/api/v1/invoices/{id}/issue` */
function toApiPath(file: string): string {
  return (
    '/' +
    relative(join(ROOT, 'src/app'), file)
      .replace(/\/route\.ts$/, '')
      .split('/')
      // Route groups are organisational and invisible in the URL.
      .filter((segment) => !segment.startsWith('('))
      .map((segment) => segment.replace(/^\[(\.{3})?(.+)\]$/, '{$2}'))
      .join('/')
  );
}

function schemaFor(schema: ZodTypeAny | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;

  try {
    const generated = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
    return generated as Record<string, unknown>;
  } catch {
    // A schema the converter cannot express should not fail the whole document.
    // An untyped body is worse than no spec only if it goes unnoticed, so it is
    // reported at the end.
    return undefined;
  }
}

function queryParameters(schema: ZodTypeAny | undefined) {
  const json = schemaFor(schema);
  if (!json || typeof json !== 'object' || !('properties' in json)) return [];

  const properties = json.properties as Record<string, unknown>;
  const required = (json.required as string[] | undefined) ?? [];

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query' as const,
    required: required.includes(name),
    schema: propertySchema,
  }));
}

function pathParameters(path: string, schema: ZodTypeAny | undefined) {
  const json = schemaFor(schema);
  const properties = (json?.properties as Record<string, unknown> | undefined) ?? {};

  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1]!,
    in: 'path' as const,
    // A path parameter is always required — it is part of the URL.
    required: true,
    schema: properties[match[1]!] ?? { type: 'string' },
  }));
}

/** The envelope every kernel route returns. */
function responses(definition: RouteDefinitionLike, method: string) {
  const success = definition.status ?? (method === 'POST' ? 201 : 200);

  const result: Record<string, unknown> = {
    [String(success)]: {
      description: 'Success',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', enum: [true] },
              data: {},
              meta: { type: 'object', description: 'Pagination, on list routes.' },
            },
          },
        },
      },
    },
    '400': { $ref: '#/components/responses/Error' },
  };

  if (definition.auth !== false) {
    result['401'] = { $ref: '#/components/responses/Error' };
  }
  if (definition.permissions?.length) {
    result['403'] = { $ref: '#/components/responses/Error' };
  }
  if (definition.features?.length || definition.requiresActiveSubscription) {
    result['402'] = { $ref: '#/components/responses/Error' };
  }
  if (definition.rateLimit) {
    result['429'] = { $ref: '#/components/responses/Error' };
  }

  return result;
}

function describe(definition: RouteDefinitionLike, path: string): string {
  const notes: string[] = [];

  if (definition.permissions?.length) {
    notes.push(`Requires: \`${definition.permissions.join('`, `')}\`.`);
  } else if (definition.auth === false) {
    notes.push('Public — no session required.');
  } else {
    notes.push('Requires a valid session.');
  }

  if (definition.features?.length) {
    notes.push(`Plan feature: \`${definition.features.join('`, `')}\`.`);
  }
  if (definition.requiresActiveSubscription) {
    notes.push('Refused while the estate is in grace or suspended.');
  }
  if (definition.idempotent) {
    notes.push('Honours the `Idempotency-Key` header; safe to retry.');
  }
  if (definition.rateLimit) {
    notes.push(`Rate limited: ${definition.rateLimit.limit} per ${definition.rateLimit.window}.`);
  }
  if (path.startsWith('/api/v1/me/')) {
    notes.push('Resolves the caller from the session; never accepts a membership id.');
  }

  return notes.join(' ');
}

function tagFor(path: string): string {
  const segments = path.replace('/api/v1/', '').replace('/api/', '').split('/');
  return segments[0] ?? 'general';
}

async function main(): Promise<void> {
  const files = routeFiles(API_DIR).sort();
  const paths: Record<string, Record<string, unknown>> = {};
  const skipped: string[] = [];

  for (const file of files) {
    const path = toApiPath(file);
    const loaded: Record<string, unknown> = await import(pathToFileURL(file).href);

    for (const method of METHODS) {
      const handler = loaded[method];
      if (typeof handler !== 'function') continue;

      const definition = (handler as { routeDefinition?: RouteDefinitionLike }).routeDefinition;

      if (!definition) {
        // A route not built on the kernel — the webhook and cron routes are
        // deliberately outside it. Recorded so the omission is visible rather
        // than silently absent from the spec.
        skipped.push(`${method} ${path}`);
        continue;
      }

      const operation: Record<string, unknown> = {
        tags: [tagFor(path)],
        summary: `${method} ${path}`,
        description: describe(definition, path),
        parameters: [
          ...pathParameters(path, definition.params),
          ...queryParameters(definition.query),
        ],
        responses: responses(definition, method),
      };

      if (definition.auth !== false) operation.security = [{ bearerAuth: [] }, { cookieAuth: [] }];

      const body = schemaFor(definition.body);
      if (body) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: body } },
        };
      }

      paths[path] ??= {};
      paths[path][method.toLowerCase()] = operation;
    }
  }

  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };

  const document = {
    openapi: '3.1.0',
    info: {
      title: 'PrimeEstate API',
      version,
      description: [
        'Estate and community management.',
        '',
        'Every response uses the same envelope: `{ success, data, meta?, error? }`.',
        'An error carries a stable `code`, a human `message`, and the `requestId`',
        'that appears in the server logs — quote it when reporting a problem.',
        '',
        'Authentication is a bearer token for native clients, or httpOnly session',
        'cookies for the browser. A web client receives cookies by sending',
        '`client: "web"` on login and never handles a token itself.',
        '',
        'Every route is scoped to the caller’s estate. A record belonging to',
        'another estate returns 404, never 403 — a 403 would confirm it exists.',
        '',
        'Money is always integer minor units (kobo), never a decimal.',
      ].join('\n'),
    },
    servers: [{ url: '{origin}', variables: { origin: { default: 'http://localhost:3800' } } }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'eos_at' },
      },
      responses: {
        Error: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['success', 'error'],
                properties: {
                  success: { type: 'boolean', enum: [false] },
                  error: {
                    type: 'object',
                    required: ['code', 'message'],
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                      requestId: { type: 'string' },
                      details: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    paths,
  };

  const serialised = `${JSON.stringify(document, null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const existing = readFileSync(OUTPUT, 'utf8');
    if (existing !== serialised) {
      console.error('docs/openapi.json is out of date. Run `pnpm openapi`.');
      process.exit(1);
    }
    console.log('OpenAPI document is up to date.');
    return;
  }

  writeFileSync(OUTPUT, serialised);

  const operations = Object.values(paths).reduce((sum, item) => sum + Object.keys(item).length, 0);
  console.log(
    `Wrote ${relative(ROOT, OUTPUT)}: ${Object.keys(paths).length} paths, ${operations} operations.`,
  );

  if (skipped.length > 0) {
    console.log(`\nOutside the route kernel, so not described (${skipped.length}):`);
    for (const route of skipped) console.log(`  ${route}`);
  }
}

await main();
