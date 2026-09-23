# Architecture

Two properties drove nearly every decision here. Everything below is downstream
of one of them.

**Security.** The system holds NIN, home addresses, records of minors, movement
history and money. A cross-tenant leak is business-ending, so isolation is
structural rather than a rule people remember.

**Gate latency.** Gate verification happens hundreds of times a day on cheap
tablets with poor connectivity. It gets a dedicated read path and never pays for
anything it does not need.

---

## Layers

```
src/
  app/            routes and screens — talk to services, never to models
  core/           the kernel: tenancy, db, http, rbac, crypto, entitlements, events
  modules/        one folder per domain: schema, service, repository, index
  integrations/   adapters behind interfaces: cache, queue, storage, payments,
                  identity, notifications
```

**The flow is one-directional:** routes → services → repositories → models.

An ESLint rule forbids `app/**` and `components/**` from importing a `schema.ts`
or a repository. This is not style. `BaseRepository` is what injects `estateId`
into every query, so a page that could reach a model could construct an unscoped
one. Making that import fail is what turns tenant isolation from a convention
into a property.

`core/` never imports `modules/` at compile time. Where it needs to — the auth
resolver, the entitlement loader — it uses a dynamic `import()`, so the
dependency runs one way and the kernel stays independently testable.

---

## The three constructs everything rests on

### 1. `RequestContext` and the scoped repository

Every authenticated request resolves to `{ userId, estateId, roles, permissions,
correlationId, isPlatformAdmin }`. `BaseRepository.scope()` injects `estateId`
into every filter, update and `$match`, and stamps it on every insert.

There is no repository method callable without a context. Compound indexes lead
with `estateId`. Cross-estate reads require the explicitly named
`PlatformRepository`, used in exactly one module.

**Cross-tenant access returns 404, never 403.** A 403 confirms the resource
exists, which is enough to enumerate another estate's records by id.

### 2. `defineRoute()`

Every `/api/v1` handler is declared rather than hand-rolled:

```ts
export const POST = defineRoute({
  permissions: ['visitor.create'],
  body: CreateVisitorPassDto,
  rateLimit: { key: 'user', limit: 30, window: '1m' },
  idempotent: true,
  handler: async (ctx, { body }) => visitorService.createPass(ctx, body),
});
```

It handles auth, permission checks, plan entitlements, Zod validation, rate
limiting, idempotency keys, correlation-id propagation, error → HTTP mapping,
and one envelope: `{ success, data, meta?, error? }`.

Consistency here is what makes the API safely reusable by a native client. It is
also what makes `docs/openapi.json` generatable — the spec is read from these
declarations, so it cannot drift from the server.

Services do their own permission checks too. The route is a second gate, not the
only one, because an operation reachable by two paths must not depend on which
path enforced it.

### 3. Append-only records

`audit_logs`, `movements` and `ledger_entries` reject `updateOne`, `updateMany`,
`findOneAndUpdate`, `deleteOne` and `deleteMany` at the ODM layer. These are the
records consulted after a theft, a dispute or a reconciliation failure. A log
that can be quietly amended is not evidence.

Audit entries are written **inside the same transaction as the mutation they
record**. A correction to the ledger is a reversing entry, never an edit.

---

## Multi-tenancy

One database, `estateId` on every tenant-scoped document, enforced by the
repository rather than by discipline. The alternative — a database per estate —
would have made the scoping mistake impossible but made onboarding, migrations
and the platform console far harder, on a product whose tenants are numerous and
small.

The trade is that the scoping must be structural. Hence the ESLint rule, the
`PlatformRepository` split, and the 404-not-403 rule.

---

## The gate fast path

`access_credentials` is a denormalised collection keyed by SHA-256 of the
scanned token, holding exactly what the gate screen renders: name, photo,
category, unit, status, blacklist flag, validity window, host.

One indexed read. No `$lookup`, no populate. Cached in Redis with a short TTL.
Domain events (`resident.approved`, `vehicle.blacklisted`, `visitor.pass_created`,
`credential.revoked`) keep it in sync.

QR payloads are opaque, HMAC-signed and rotatable, so a photograph of an old QR
fails.

The gate routes carry no 3D and no charting. `pnpm build` enforces a per-route
bundle budget, and `pnpm bench:gate` asserts p95 latency and that the query uses
an index scan. Both fail the build rather than degrading quietly.

---

## Events

An in-process bus with a typed event map (`src/core/events/types.ts`). Handlers
fan out to notifications, analytics and cache invalidation, and forward to the
queue for async work.

**A handler failure never propagates to the caller.** A notification provider
being down must not roll back the gate entry that triggered it.

The event names are a contract in three directions: internal handlers, the
future outbound-webhook surface, and the device integration seam. Renaming one is
breaking; new names get added instead.

---

## Money

Integer minor units (kobo) everywhere. Floating-point money accumulates error
that only becomes visible once totals are large enough for someone to notice.

Double-entry ledger, append-only, balance enforced at post time — an unbalanced,
single-sided, zero or fractional transaction is refused. An invoice's ledger
entry and its status change commit in one transaction, which is why MongoDB must
be a replica set.

Payment providers sit behind an interface. The webhook verifies an HMAC over the
**raw body**, claims the event id under a unique index before doing any work,
then **re-verifies the amount against the provider's API** — a valid signature
proves the message came from the provider, not that the body was not replayed
from a smaller charge. Nothing the browser reports after checkout is trusted.

---

## Entitlements

`core/entitlements` resolves an estate's subscription into
`{ features, limits, readOnly }`. Routes declare `features: []` and
`requiresActiveSubscription`; limit checks run inside the creating transaction so
a race cannot exceed a cap.

The seam was built before it gated anything. Retrofitting a check across ninety
routes at once is how one gets missed, and a missed check is a paid feature
served free with no test to catch it — nobody writes a test for a check they
forgot to add. Same argument as putting tenant scoping in the base repository.

**Grace and suspension stop writes and leave reads working.** An estate that
forgets to pay must not lose its gate; residents queuing at a barrier that will
not open is a safety problem, not a billing one.

---

## Portability

Every integration is an interface with at least two adapters, so serverless and
self-hosted are a configuration difference rather than a fork:

| Seam | Adapters |
|---|---|
| Cache | memory · ioredis · Upstash REST |
| Queue | inline · BullMQ |
| Storage | local · S3 (also R2, MinIO) |
| Payments | mock · Paystack |
| Identity | mock · Dojah |
| Notifications | console · Resend · Termii |

The mock adapters are not stubs. The mock payment provider signs webhooks with
the same HMAC scheme as Paystack, so the signature-verification path is genuinely
exercised — a suite that skipped it would pass against a server that accepts
forged webhooks.

---

## Testing

- **Unit and integration** (Vitest, `mongodb-memory-server` with real
  transactions) — services, RBAC, crypto, entitlements, billing, tenant
  isolation per module.
- **`pnpm smoke`** — signs in as each role and drives every screen with a real
  session cookie, then asserts the permission boundaries.

The second exists because the first was not enough. Ten phases passed with green
tests while most of the UI did not exist, and both permission leaks found in this
codebase were found by driving the API as a real signed-in user. A unit test
asserts the permission its author chose; only a real session asserts the
permission the role actually has.

`pnpm build` additionally fails on a navigation link with no page behind it, and
on any bundle over budget.

---

## Where the seams are for what comes next

- **Devices** (RFID, ANPR, boom gates) — a `DeviceAdapter` posting to signed
  device endpoints. Not implemented; the seam and the events are.
- **Outbound webhooks** — the domain event map is the surface.
- **Native clients** — the API was built for this: one envelope, bearer tokens
  alongside cookie sessions, and a generated OpenAPI document.
- **Geolocation** — an optional `GeoPoint` on movement, emergency and incident
  records, plus a `LocationProvider` interface. No hardware coupling.
