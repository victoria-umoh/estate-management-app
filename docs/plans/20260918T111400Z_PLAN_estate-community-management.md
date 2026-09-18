# Estate & Community Management SaaS — Implementation Plan

## Context

`/Users/premiumcoder/Sites/tpc/apps/estate-management-app` is an empty git repo (no commits, only a stray `.letta/` dir). We are building a production-grade, multi-estate **Estate & Community Management SaaS** from zero: identity-verified residents, properties, households, vehicles, gate/security operations, visitor and exit passes, incidents and emergencies, dues and Paystack payments, notifications, reporting/analytics, granular RBAC, and full audit trails — delivered as a Next.js web app whose API is built to be consumed unchanged by future native iOS/Android clients.

This is deliberately **not** a CRUD app. The two properties that drive nearly every architectural decision are:

1. **Security.** The system holds NIN, home addresses, minors' records, movement history and money. A cross-tenant leak or an unaudited privilege escalation is a business-ending event. Authorization is enforced server-side at the data-access layer, not in UI.
2. **Gate latency.** Gate verification happens hundreds of times a day on cheap tablets with poor connectivity. It gets a dedicated denormalized read path and is never allowed to depend on expensive joins or the 3D/motion layer.

Confirmed decisions: shared MongoDB with mandatory `estateId` scoping; custom JWT + refresh tokens (mobile-ready); selective 3D on marketing/ID/map surfaces with fast motion everywhere else; portable runtime (Vercel **and** self-hosted Docker, every integration behind an interface); Paystack for both SaaS subscriptions and resident dues via per-estate subaccounts; pluggable NIN verification with a deterministic mock adapter.

---

## Stack

| Concern        | Choice                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| Framework      | Next.js 15 App Router, React 19, TypeScript `strict`                                   |
| Data           | MongoDB 7 + Mongoose 8 (replica set — required for transactions)                       |
| Validation     | Zod — one schema shared by API contract, forms, and OpenAPI generation                 |
| UI             | Tailwind CSS v4, shadcn/ui (Radix), Framer Motion, React Three Fiber + drei (lazy)     |
| Client data    | TanStack Query v5                                                                      |
| Charts         | Recharts (chart work follows the `dataviz` skill)                                      |
| Auth crypto    | `@node-rs/argon2` (argon2id), `jose` (JWT), `otplib` (TOTP)                            |
| Payments       | Paystack (subscriptions + transactions)                                                |
| Storage        | `@aws-sdk/client-s3` — works against S3, Cloudflare R2, and MinIO                      |
| Cache / limits | Redis via `ioredis` (self-host) or Upstash REST (serverless), behind one interface     |
| Jobs           | BullMQ worker (self-host) **or** signed Vercel Cron routes — same `JobQueue` interface |
| Observability  | `pino` structured logs, correlation IDs, OpenTelemetry-shaped spans, Sentry-ready      |
| Tests          | Vitest + `mongodb-memory-server` (unit/integration), Playwright (e2e)                  |

---

## Architecture

### Directory layout

```
src/
  app/
    (marketing)/          # landing, pricing, features — 3D hero
    (auth)/               # login, register, verify, reset
    (app)/                # authenticated shell: resident | security | admin | chairman
    api/v1/…              # versioned REST API — the mobile contract
  core/
    tenancy/              # RequestContext, estate scoping guard
    auth/                 # tokens, sessions, devices, OTP, 2FA, lockout
    rbac/                 # permission registry, roles, can()
    audit/                # append-only audit writer
    db/                   # connection, transactions, base repository
    crypto/               # AES-256-GCM field encryption, HMAC blind index
    events/               # in-process event bus -> queue dispatch
    http/                 # defineRoute() kernel, response envelope, errors
    entitlements/         # plan limits + feature gates
    logging/ config/ errors/
  modules/<module>/       # estate, property, resident, household, tenancy,
                          # vehicle, gate, visitor, pass, incident, emergency,
                          # billing, payment, ledger, notification, announcement,
                          # service-request, document, report, subscription
    schema.ts  dto.ts  repository.ts  service.ts  permissions.ts  index.ts
  integrations/           # payments/ notifications/ storage/ identity/ queue/ cache/ geo/ devices/
  components/             # ui/ (design system), motion/, three/, feature components
  lib/
tests/  scripts/  docs/
```

**Rule enforced by ESLint:** `app/**` and `components/**` may not import `schema.ts` or call Mongoose models directly. Routes call services; services call repositories; only repositories touch models. This is what keeps business logic out of UI and makes tenant scoping unbypassable.

### The three constructs everything else rests on

**1. `RequestContext` + tenant-scoped base repository.**
Every authenticated request resolves to `{ userId, estateId, roles, permissions, plan, ip, userAgent, correlationId }`. `BaseRepository` injects `estateId` into every filter, update and aggregation `$match`, and stamps it on every insert. There is no repository method that can be called without a context. Compound indexes lead with `estateId`. Cross-estate platform queries live in a separate explicitly-named `PlatformRepository` reachable only by super-admin permissions.

**2. `defineRoute()` API kernel** (`core/http`) — every `api/v1` handler is declared, not hand-rolled:

```ts
export const POST = defineRoute({
  permissions: ['visitor.create'],
  body: CreateVisitorPassDto,
  rateLimit: { key: 'user', limit: 30, window: '1m' },
  idempotent: true,
  audit: { action: 'visitor.pass.created', resource: 'visitor_pass' },
  handler: async (ctx, { body }) => visitorService.createPass(ctx, body),
});
```

It handles: auth + session validity, permission check, plan entitlement check, Zod validation, rate limiting, idempotency keys, correlation ID propagation, audit emission, error → HTTP mapping, and a consistent envelope `{ success, data, meta, error }`. Consistency here is what makes the API safely reusable by mobile.

**3. Append-only audit log.** Written inside the same transaction as the mutation it records. No update/delete route exists for `audit_logs`; the app's Mongo user is granted insert+find only on that collection. Captures actor, action, resource, resource id, before/after diff (sensitive fields redacted), IP, device, timestamp.

### Sensitive-data handling (NIN and friends)

- NIN, document numbers and bank details are encrypted at rest with AES-256-GCM using a key from `ENCRYPTION_KEY`, stored as `{ ct, iv, tag, keyVersion }` to allow rotation.
- A separate HMAC-SHA256 **blind index** (`ENCRYPTION_BLIND_INDEX_KEY`) provides a unique index for duplicate-identity detection without storing plaintext.
- The default serializer returns NIN masked (`•••••••1234`). The full value requires `resident.viewNin`, is served by a dedicated endpoint, and every read writes an audit entry. It never appears in list responses, logs, or error messages.

### Gate verification fast path

A denormalized `access_credentials` collection is the gate's single source of truth: keyed by SHA-256 of the scanned token, holding exactly what the gate screen renders (display name, photo URL, category, house number, status, blacklist flag, valid-from/until, host). One indexed lookup, Redis-cached with short TTL, no `$lookup`, no populate. Domain events (`resident.approved`, `vehicle.blacklisted`, `visitor.pass.created`, `pass.revoked`) keep it in sync. QR payloads are opaque, HMAC-signed and rotatable — scanning a photo of an old QR fails. The gate UI ships as a route group with no 3D bundle and an offline-tolerant recent-scan cache.

### Events & device readiness

An in-process bus (`emit('visitor.overstayed', payload)`) fans out to notification, analytics and audit handlers, and forwards to the `JobQueue` for async work. Named events (`resident.checked_in`, `vehicle.entered`, `payment.completed`, `emergency.triggered`, …) double as the future outbound-webhook and IoT integration surface. Device integrations (RFID, ANPR, boom gates, panic buttons) are modeled as `DeviceAdapter` implementations posting to signed device endpoints — none implemented now, the seam is.

Geolocation is likewise a seam: an optional `GeoPoint` on movement/emergency/incident records plus a `LocationProvider` interface. No GPS hardware coupling.

---

## SaaS pricing model

Trial: **30 days, full Professional, no card required**, capped at 100 units. Expiry → read-only grace for 14 days, then suspend (data retained 90 days).

|                                                                                                                   | **Starter**   | **Professional** | **Enterprise**  |
| ----------------------------------------------------------------------------------------------------------------- | ------------- | ---------------- | --------------- |
| Units                                                                                                             | ≤ 100         | ≤ 500            | Unlimited       |
| Gates                                                                                                             | 1             | 4                | Unlimited       |
| Admin seats                                                                                                       | 2             | 10               | Unlimited       |
| Core: residents, properties, vehicles, visitors, gate logs, announcements, digital ID                             | ✓             | ✓                | ✓               |
| Dues, invoicing, Paystack collections, ledger, receipts                                                           | —             | ✓                | ✓               |
| Incidents, emergencies, service requests, exit passes                                                             | —             | ✓                | ✓               |
| SMS notifications                                                                                                 | pay-as-you-go | bundle included  | bundle included |
| Custom roles, reports & exports, scheduled reports                                                                | —             | ✓                | ✓               |
| Multi-estate group dashboard, API keys + outbound webhooks, device/RFID/ANPR, SSO, white-label, audit export, SLA | —             | —                | ✓               |

Billing monthly or annual (annual = 2 months free), priced per occupied unit band. Add-ons: extra SMS credits, extra gates, ANPR module.

**Entitlements are server-side.** `core/entitlements` resolves the estate's subscription into `{ features: Set<Feature>, limits: Record<Limit, number> }`; `defineRoute` rejects gated features with `402 FEATURE_NOT_IN_PLAN`, and limit checks run inside the creating transaction so a race can't exceed a cap. Failed subscription charge → dunning schedule → grace → suspend, all driven by Paystack webhooks and never by the browser.

---

## Implementation phases

Each phase ends with: tests green, `docs/PROGRESS.md` updated, and an appended timestamped entry in `docs/OUTPUT_LOGS.md`.

| #   | Phase                     | Delivers                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Foundation**            | pnpm workspace, Next 15 + TS strict, Tailwind v4, ESLint (incl. layering rule), Prettier, Vitest, Playwright, `docker-compose.yml` (Mongo RS + Redis + MinIO), `.env.example` fully commented, `.gitignore`, `docs/PROGRESS.md`, `docs/OUTPUT_LOGS.md`                                                              |
| 1   | **Core platform**         | config loader (Zod-validated env), Mongo connection + transaction helper, `BaseRepository` + tenancy guard, crypto (AES-GCM + blind index), error taxonomy, pino logging + correlation IDs, event bus, `defineRoute()` kernel, rate limiter, idempotency store, cache/queue/storage interfaces + both adapters each |
| 2   | **Auth & identity**       | register → email verify → phone OTP → NIN verify (mock adapter) → property claim → admin approval; login/logout, refresh rotation + reuse detection, password reset, TOTP 2FA, session & device registry, lockout, suspicious-login detection, duplicate-identity detection                                         |
| 3   | **RBAC & audit**          | permission registry (~90 `resource.action` strings), system + custom estate roles, `can()`, route/service enforcement, append-only audit log with diffing and redaction, audit viewer UI                                                                                                                            |
| 4   | **Design system & shell** | tokens, light/dark, buttons/forms/tables/modals/cards/badges/alerts/empty+loading+error states, confirm dialogs, toasts, command palette, responsive app shell with role-aware nav, motion primitives, lazy R3F scene wrapper                                                                                       |
| 5   | **Estate core**           | estates & settings, properties (+ ownership/tenant history, transfer), residents & profiles, households & dependants, tenant lifecycle (invite → approve → renew → exit), sensitive-field change-approval workflow, configurable approval workflows                                                                 |
| 6   | **Identity assets**       | Estate ID generation, digital ID card (3D flip, printable PDF), signed rotating QR, ID lifecycle states, vehicles + documents + blacklist, vehicle QR                                                                                                                                                               |
| 7   | **Gate & security**       | gates, officer assignment, `access_credentials` fast path, scanner UI (camera + manual search), entry/exit logging, visitor passes, temporary passes, exit/removal passes with item manifests + approvals, overstay detection job + alerts, security dashboard, blacklist checks                                    |
| 8   | **Safety**                | incident reporting (media upload, severity, assignment, resolution, escalation), emergency button + responder notification + response tracking, service-request ticketing with SLA/escalation                                                                                                                       |
| 9   | **Money**                 | fee categories, billing rules (monthly/quarterly/yearly/one-time, property- or resident-based), invoice generation job, double-entry ledger, Paystack init/verify/webhook (raw-body HMAC + idempotency), receipts, refunds, reconciliation, finance dashboard + exports                                             |
| 10  | **Communication**         | notification service + templates, email adapter (Resend/SendGrid), SMS adapter (Termii), in-app notification center, announcements, preference management                                                                                                                                                           |
| 11  | **Insight**               | global search (resident/phone/NIN blind index/plate/visitor code/ticket/payment ref), gate-optimized fast search, role dashboards (resident, security, chairman, finance), analytics aggregations, report engine with CSV/Excel/PDF + scheduling                                                                    |
| 12  | **SaaS layer**            | plans & subscriptions, self-serve estate signup + trial, entitlement enforcement, Paystack subscription webhooks, dunning/grace/suspension, per-estate subaccount config, billing portal, super-admin platform console, marketing site (3D hero) + pricing page                                                     |
| 13  | **Hardening**             | test suites to target coverage, OpenAPI 3.1 spec + Swagger UI, seed/demo data + demo accounts per role, security review pass, performance/index audit, `docs/DEPLOYMENT.md`, `docs/SECURITY.md`, `docs/API.md`, `docs/ARCHITECTURE.md`                                                                              |

---

## Testing

- **Unit** — services, RBAC `can()`, crypto, entitlement resolution, billing math, overstay logic.
- **Integration** (`mongodb-memory-server`, real transactions) — auth flows, **tenant isolation** (every module: estate A must never read/write estate B), permission enforcement per route, payment webhook idempotency and signature rejection, invoice/ledger correctness, visitor pass lifecycle, gate verification correctness and latency budget.
- **E2E** (Playwright) — the six spec workflows: registration, visitor, overstay, payment, exit pass, emergency. Plus dark/light and mobile-viewport passes on gate scanner, ID card, visitor pass and emergency button.
- **Security regression suite** — NIN never in list responses or logs; audit log immutability; rate limits; refresh-token reuse detection; unsigned webhook rejection.

---

## Housekeeping the user asked for

- `.gitignore` covers `.letta/`, `.claude/`, `.env*`, build artifacts; the existing untracked `.letta/` directory is removed from the working tree and never committed.
- No AI/assistant/co-author attribution anywhere: no `Co-Authored-By` trailer, no signature lines in commits, PRs, docs, changelogs or code comments. Commit messages are written in the repository author's voice.
- `docs/plans/` — every approved plan is archived here as `{{timestamp}}_PLAN_{{plan_name}}.md`. This plan lands first, as `docs/plans/20260918_PLAN_estate-community-management.md`, and any later approved plan is added alongside it rather than overwriting.
- `docs/PROGRESS.md` — live resumable checklist: phase, task, status, next action, open decisions. Updated continuously so work can stop and resume at any point.
- `docs/OUTPUT_LOGS.md` — every response/report appended with `---` separator and ISO timestamp, recording what was done, what happened, and decisions taken.
- `.env.example` — every variable with an explanatory comment, grouped by concern (app, database, auth/crypto, storage, cache, queue, Paystack, email, SMS, identity verification, observability, feature flags).

---

## Verification

```bash
# 1. Infrastructure (Mongo replica set required for transactions)
docker compose up -d && pnpm db:wait

# 2. Seed a demo estate with properties, residents, vehicles, gate logs,
#    payments, incidents and one demo account per role
pnpm seed

# 3. Quality gates
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e

# 4. Run and walk the flows
pnpm dev
```

Manual end-to-end acceptance, per role:

1. **Register** a resident → email verify → OTP → NIN (mock) → claim property → admin approves → ID + QR issued → welcome notification received.
2. **Visitor**: resident creates a pass → open the security dashboard in a second browser profile → scan/enter the code → visitor shows Inside → check out → visit closed.
3. **Overstay**: create a pass expiring in the past, run `pnpm job:overstay` → alert on security dashboard + host notified.
4. **Payment**: pay an outstanding invoice with a Paystack test card → confirm the invoice only flips to paid after the webhook lands (kill the browser mid-redirect to prove the browser isn't trusted) → ledger balanced, receipt issued.
5. **Exit pass** and **Emergency** flows end to end, each producing a complete audit trail.
6. **Tenant isolation**: log in as Estate B admin and attempt to fetch an Estate A resident/property/payment by id — every attempt returns 404, and the integration suite asserts this for every module.
7. **Gate latency**: `pnpm bench:gate` asserts p95 verification under the budget with a warm cache.
8. Toggle light/dark and check 320px → 2560px on gate scanner, ID card, visitor pass, emergency button, dashboards.
