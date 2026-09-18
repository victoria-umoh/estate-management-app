# Implementation Progress

**Purpose:** this file is the resume point. If work stops at any moment, read
"Next action" below and continue from there. It is updated at every phase
boundary and whenever a decision is made that future work depends on.

**Last updated:** 2026-09-18
**Current phase:** 3 complete — starting Phase 4 (Design system & app shell)
**Next action:** build the design system on the Phase 0 tokens: primitives
(button, input, table, modal, card, badge, alert), empty/loading/error states,
the role-aware app shell, and the lazy R3F scene wrapper.

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

- [ ] (see plan)

## Phase 10 — Notifications & announcements

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
