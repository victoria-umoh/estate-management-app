# Output Logs

A running record of work performed, outcomes, and decisions taken. Newest
entries are appended at the bottom, each separated by `---` and stamped with a
timestamp.

---

## 2026-09-18 11:30 UTC — Phase 0: Foundation complete

### What was done

Planned the system end to end and scaffolded the project foundation.

**Planning.** Confirmed six architecture decisions with the user before writing
code (tenancy model, auth stack, 3D intensity, runtime target, payments split,
NIN verification approach). Plan archived to
`docs/plans/20260918T111400Z_PLAN_estate-community-management.md`.

**Scaffolding.**
- `package.json` — Next 15 / React 19 / TypeScript strict, plus the full
  dependency set for the 14 planned phases. Build scripts are allow-listed
  explicitly rather than blanket-enabled.
- `tsconfig.json` — strict mode with `noUncheckedIndexedAccess`.
- `eslint.config.mjs` — includes the layering rule that makes tenant isolation
  structural: UI and route files cannot import Mongoose schemas or repositories,
  and components cannot import server config, crypto or integration clients.
- `.env.example` — 400+ lines, every variable commented with its purpose and
  its failure mode.
- `docker-compose.yml` — MongoDB as a single-node replica set, Redis, MinIO with
  a private bucket.
- Design tokens in OKLCH with light/dark themes, fixed status colour semantics,
  and motion durations tuned for an operations tool.
- Test harness with an in-memory MongoDB replica set.

### Problems found and fixed

1. **MinIO image would not pull.** `minio/minio` on Docker Hub is access-gated.
   Switched to `quay.io/minio/minio`, which is what MinIO actually publishes to.
2. **Three host port collisions.** 27017 is taken by a local Homebrew mongod;
   6379/6380 and 9000/9001 by other projects on this machine. Remapped to
   27018 / 6381 / 9002-9003. In-container ports unchanged.
3. **Invalid Mongo connection string.** The original URI combined
   `directConnection=true` with `replicaSet=rs0`; drivers reject that pairing.
   Dropped the `replicaSet` parameter — transactions still work because we
   connect straight to the primary.
4. **`@newrelic/next` is deprecated upstream.** Removed; using the base
   `newrelic` agent, which instruments at require-time.
5. Two lint failures: a generated `next-env.d.ts` triple-slash reference (now
   ignored), and `useTestDatabase` tripping the React hooks rule because of its
   `use` prefix (renamed to `setupTestDatabase`, which is also more accurate).

### Decisions taken

- **Session replay defaults to off** in the Sentry configuration. This
  application displays NIN, home addresses and minors' records; recording
  sessions without configured masking would export exactly the data the rest of
  the security design protects.
- **New Relic high-security mode is documented as recommended-on for
  production**, because request bodies carry NIN, phone numbers and payment
  references that must not leave the platform inside telemetry.
- The test harness asserts that transactions both **commit and roll back**.
  Without the rollback assertion, a harness that silently degraded to standalone
  mongod would let financial tests pass for the wrong reason.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 5 tests, 2 files |
| `pnpm build` | pass — 102 kB First Load JS |
| `docker compose up -d` | pass — all services healthy |
| `pnpm db:wait` | pass — replica set `rs0` has a primary |
| MinIO bucket | created, access set to **private** |

### Next

Phase 1 — Core platform: config loader, database layer with the `estateId`
tenancy guard, crypto (AES-256-GCM + blind index), error taxonomy, logging with
correlation IDs, event bus, the `defineRoute()` API kernel, and the
cache/queue/storage adapter pairs.

