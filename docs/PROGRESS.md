# Implementation Progress

**Purpose:** this file is the resume point. If work stops at any moment, read
"Next action" below and continue from there. It is updated at every phase
boundary and whenever a decision is made that future work depends on.

**Last updated:** 2026-09-26
**Current phase:** 15 — every endpoint a person uses has a screen

**The bar changed this phase.** A phase is no longer done when the service works
and the tests are green. It is done when the screen loads, signed in, as the
role that uses it — verified by `pnpm smoke`, which drives every screen and
endpoint over HTTP as all three roles. Ten phases were reported complete under
the old bar while 18 of 24 navigation links went to screens that did not exist.

**How to tell what is left.** Count the permissions in
`src/core/rbac/permissions.ts` that appear nowhere in `src/modules` or
`src/app`:

```bash
grep -oE "^  [A-Z_0-9]+:" src/core/rbac/permissions.ts | tr -d ' :' | while read c; do
  n=$(grep -rlE "PERMISSIONS\.$c\b|P\.$c\b" src/modules src/app 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "0" ] && echo "  $c"
done
```

A permission is declared when someone decides a capability should exist and
referenced only when it does, so the gap between the two is the honest backlog —
more honest than a phase checklist, which says what was planned rather than what
is there. It went 52 → 25 → **5 of 126**, and those five are the withdrawn
`user.*` strings below. Every permission meant to gate something now does.

Match the _constant_, not the string. Code says `PERMISSIONS.DOCUMENT_VIEW`, so
grepping for `'document.view'` reports almost every permission as unenforced.
An earlier version of this command did exactly that and read 118 when the true
figure was 5.

**Not every one deserves an implementation.** `user.*` was withdrawn rather than
built: a user is global and a membership is per-estate, so an estate
administrator suspending a _user_ would lock that person out of another estate.
Some declared permissions deserve a decision instead.

**Phase 14 is complete and verified.** Documents (storage-backed, type verified
against magic bytes, EXIF stripped, downloads forced to octet-stream), tenant
lifecycle (approve/renew with lease history preserved across renewals), resident
suspend/delete (revoking the resident's pass _and_ their vehicles' credentials,
because a car is another way through the same gate), the four soft deletes,
vehicle and gate update, service-request comments, self-serve estate signup with
a trial and a verification link that actually bites, and the invoice, payment
and audit exports.

Gate set on a quiet server: typecheck 0, lint clean, **967 unit tests / 48
files**, build green with 28 nav links resolving and all bundles within budget,
143 indexes synced, index audit passed, `pnpm smoke` all green, **38/38
end-to-end in 2.5 minutes**, OpenAPI at 121 paths / 166 operations.

**On running the gates:** a background dev server respawning mid-`next build`
corrupts `.next` and fails the build and roughly two e2e specs for reasons that
look like app defects and are not. The same suite went 36/38 in 10 minutes under
contention and 38/38 in 2.5 minutes alone. Confirm nothing else is running
(`ps aux | grep "[n]ext"`) before believing a build or e2e failure.

**Phase 15 is complete and verified.** The permission count said the backlog was
done; a second measure said otherwise. About fifty working endpoints had no
screen calling them — including sign-out, password reset, the emergency button
and every admin create/edit action. Now built: sign-out and an account page
(password change, signed-in devices), forgot/reset password, resident
self-registration and email verification, invitation acceptance, resident
service requests, a Safety page (hold-to-send emergency, incident reports),
temporary pass issue, the payment return page, invitations and change-request
approvals, resident suspend/delete/roles/dependants, custom role edit/delete,
property create/assign/delete, vehicle register/edit/verify/delete, gate
management, fee and invoice actions, manual payments, report schedules,
platform estate creation, gate deny, and temporary pass revoke.

Backend fixes found on the way: login 401'd on a stale session cookie; phone
OTP never recorded the phone as verified and would text any number; register
accepted estates and properties that do not exist; a weak password burned an
invitation; manual payments could credit a draft invoice or another household;
a resumed report schedule fired at once; the client retried wrong-password
401s through a refresh, spending two attempts per guess.

Gate set: typecheck 0, lint clean, **979 unit tests / 48 files**, build green
with 31 nav links and all bundles within budget, `pnpm smoke` all green with
the new screens added, e2e 37/38 — `overstay.spec.ts` dropped its connection
(ECONNRESET) twice and passed on the third run.

**Since then:** residents have an incident detail page with its conversation;
pages read the viewer's permissions through one helper (`src/lib/viewer.ts`)
instead of each decoding the cookie; the sidebar shows the real name and estate
instead of "Signed in" / "Estate"; gate refusals record the direction the
officer has set, not always "in"; the account page links the phone/NIN checks.

**Next action:** the open decisions below. Nothing else is queued.

**Open decisions (need the owner):**

- Should residents issue temporary passes? No resident role holds
  `temporaryPass.create`, and there is no "my temporary passes" list endpoint,
  so the form on `/my/visitors` currently shows "issued by the estate office".
- Should phone/NIN checks happen _before_ approval? Today they need a signed-in
  session and pending members cannot sign in, so they happen after
  (`/register/identity`, linked from the account page but not the approval email).
- `/api/v1/gate/verify` is dead — `/gate/scan` does the same check and logs it.
- There is no way to invite a new estate's chairman from the platform console.
- CI has never started: every run is `startup_failure` with no jobs. The
  workflow file and self-hosted runner check out; the reason is only shown on
  the GitHub run page (likely an account billing lock).

**Standing caveats:**

- `pnpm build` and `pnpm dev` share `.next` and corrupt each other. Use
  `pnpm clean` between them.
- The e2e suite passes on a fresh dev server and decays on a reused one. If a
  run is flaky, restart the server before suspecting the tests.

---

## Legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Phase 0 — Foundation

- [x] Directory structure (`src/{app,core,modules,integrations,components,lib}`, `docs`, `tests`, `scripts`)
- [x] `package.json` — scripts and dependency set
- [x] `tsconfig.json` — strict, `noUncheckedIndexedAccess`, `@/*` path alias
- [x] `.gitignore` — excludes `.env*`, `.letta/`, `.claude/`, build output
- [x] `.env.example` — every variable documented with a comment
- [x] `next.config.mjs` — security headers, server-external packages
- [x] `eslint.config.mjs` — including the layering rule that protects tenant isolation
- [x] `.prettierrc.json`
- [x] `vitest.config.ts`, `playwright.config.ts`
- [x] `docker-compose.yml` — Mongo replica set, Redis, MinIO (private bucket)
- [x] `docs/PROGRESS.md`, `docs/OUTPUT_LOGS.md`, `docs/plans/`
- [x] `pnpm install` (build scripts allow-listed explicitly)
- [x] Tailwind v4 theme + design tokens (OKLCH, light/dark, status colours, motion)
- [x] Root layout, theme provider, skip-link, landing placeholder
- [x] `tests/setup.ts` + in-memory Mongo replica-set harness
- [x] Harness test proving transactions commit AND roll back
- [x] Helper scripts: `wait-for-db`, `generate-keys`
- [x] Sentry + New Relic dependencies and env configuration
- [x] Green `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- [x] Docker stack verified: replica set primary elected, private bucket created
- [x] Initial commit

## Phase 1 — Core platform

- [x] `core/config` — Zod-validated env loader, fails fast, production guards
- [x] `core/db` — connection, transaction helper, `BaseRepository` + tenancy guard
- [x] `core/crypto` — AES-256-GCM field encryption, HMAC blind index, signed QR tokens
- [x] `core/errors` — error taxonomy, normalisation, safe serialisation
- [x] `core/logging` — pino, correlation IDs via AsyncLocalStorage, redaction
- [x] `core/events` — in-process bus with handler isolation
- [x] `core/http` — `defineRoute()` kernel, envelope, rate limit, idempotency
- [x] `core/tenancy` — RequestContext, permission helpers, tenant assertions
- [x] `integrations/cache` — memory | ioredis | upstash
- [x] `integrations/queue` — inline | bullmq (cron-route runs handlers directly)
- [x] `integrations/storage` — local | s3, with magic-number upload validation
- [x] `core/observability` — Sentry (lazy-loaded), New Relic agent config, scrubbing
- [x] Tests — 238 passing, including 22 tenant-isolation tests against a real replica set

## Phase 2 — Auth & identity

- [ ] (see plan)

## Phase 3 — RBAC & audit

- [ ] (see plan)

## Phase 4 — Design system & app shell

- [ ] (see plan)

## Phase 5 — Estate core

- [ ] (see plan)

## Phase 6 — Identity assets (ID cards, vehicles)

- [ ] (see plan)

## Phase 7 — Gate & security

- [ ] (see plan)

## Phase 8 — Incidents, emergencies, service requests

- [ ] (see plan)

## Phase 9 — Billing, dues, Paystack, ledger

- [x] Double-entry ledger, append-only, balance enforced at post time
- [x] Fee categories (monthly/quarterly/yearly/one-time, property or resident)
- [x] Invoice lifecycle: draft → issue → paid / overdue / cancelled
- [x] Paystack provider behind an interface, with a signing mock
- [x] Webhook: raw-body HMAC, constant-time compare, idempotent, re-verified
- [x] Manual payment recording behind `payment.verify`
- [x] Billing run and overdue sweep jobs
- [x] API routes and the `/admin/finance` + `/my/payments` screens
- [x] 34 tests, including signature rejection and duplicate delivery
- [x] Fixed: `invoice.view` leaked every household's invoices to residents

## Phase 10 — Money: fees, invoices, ledger, Paystack

- [x] Complete — see OUTPUT_LOGS 2026-09-23T08:45Z

## Phase 11 — Application catch-up

- [x] 17 screens built; every nav link now resolves or is flagged `planned`
- [x] 14 missing API routes exposed (incident + service-request lifecycles,
      role update, the whole `/me/*` family)
- [x] `MeService` — caller identity resolved from the session, never the body
- [x] `api.getPage()` and idempotency-key support in the browser client
- [x] Fixed: finance screen read the wrong response shape
- [x] Fixed: two screens depended on a localStorage key nothing ever wrote
- [x] `pnpm smoke` — 47 checks across screens, endpoints and permission guards

## Phase 12 — Notifications & announcements

- [ ] (see plan)

## Phase 11 — Dashboards, search, reports, analytics

- [ ] (see plan)

## Phase 12 — SaaS layer

- [ ] (see plan)

## Phase 13 — Hardening, docs, seeds

- [ ] (see plan)

---

## Decisions taken

| Date       | Decision                                               | Rationale                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-18 | Shared MongoDB with mandatory `estateId` scoping       | Cheapest to operate and scales to thousands of estates. The leak risk is handled structurally: only repositories may touch models (ESLint-enforced), and the base repository injects `estateId` into every query. |
| 2026-09-18 | Custom JWT + rotating refresh tokens                   | Identical contract for web and future native mobile clients. Auth.js would need a separate token bridge for mobile.                                                                                               |
| 2026-09-18 | Selective 3D                                           | The gate scanner must stay fast on cheap tablets, so it ships with no 3D bundle. Three.js is reserved for marketing, the digital ID card and the estate map.                                                      |
| 2026-09-18 | Portable runtime, adapters for every integration       | Ships to both Vercel and self-hosted Docker without a rewrite.                                                                                                                                                    |
| 2026-09-18 | Paystack for both SaaS subscriptions and resident dues | One SDK and one webhook handler; per-estate subaccounts settle dues to the estate while platform revenue settles to the operator.                                                                                 |
| 2026-09-18 | NIN via pluggable provider with a mock adapter         | No external cost or credentials needed for development, demos and tests. NIN is encrypted at rest with a blind index for duplicate detection.                                                                     |
| 2026-09-18 | Mongo runs as a single-node replica set locally        | Multi-document transactions are required for financial and critical state changes; standalone mongod does not support them.                                                                                       |

## Open questions

- Paystack subaccount support must be enabled on the live account before Phase 12 can be tested outside test keys.
- Live NIN provider (Dojah vs Prembly) to be chosen when credentials are available; the adapter seam means this is a config change, not a code change.
