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

---

## 2026-09-18 13:30 UTC — Phase 1: Core platform complete

### What was built

The layer every feature module will sit on. Twelve subsystems, 238 tests.

| Subsystem | What it does |
|---|---|
| `core/config` | Zod-validated env loader. Refuses to boot on bad config rather than failing later inside a payment webhook. |
| `core/errors` | Error taxonomy with stable machine-readable codes, normalisation of unknown throws, and safe serialisation. |
| `core/crypto` | AES-256-GCM field encryption, HMAC blind indexes, signed opaque QR tokens. |
| `core/logging` | pino with hard redaction and correlation IDs propagated via AsyncLocalStorage. |
| `core/tenancy` | `RequestContext` and the assertions that guard it. |
| `core/db` | Connection caching, transaction helpers, and `BaseRepository` — the tenant boundary. |
| `core/events` | Domain event bus with handler isolation. |
| `core/http` | `defineRoute()` kernel: auth, authz, validation, rate limiting, idempotency, envelope, error mapping. |
| `core/observability` | Sentry + New Relic, both opt-in, with outbound scrubbing. |
| `integrations/cache` | memory / ioredis / upstash behind one interface. |
| `integrations/queue` | inline / BullMQ behind one interface. |
| `integrations/storage` | local / S3, with magic-number upload validation. |

### Decisions taken

**Cross-tenant access returns 404, not 403.** A 403 confirms the record exists,
which would let an attacker enumerate another estate's residents, plates and
invoice references by probing IDs. 404 leaks nothing. This is asserted in tests
rather than left as a convention.

**Repositories reject filters carrying their own `estateId`**, and reject updates
that change `estateId` or `_id`. Silently overwriting would conceal either a bug
or a deliberate attempt to escape the tenant boundary; throwing surfaces both.
The write-side guard matters as much as the read-side one — without it,
`updateById(ctx, id, { estateId: other })` would move a record out of its tenant.

**The blind-index key is separate from the encryption key**, and the field kind
is mixed into the HMAC. There are only 10^11 possible NINs, so a bare SHA-256
index would be trivially reversible by brute force; the key is what prevents
that. Separate keys mean compromising one does not compromise the other, and
mixing the kind stops a NIN and a phone number that share digits from
correlating.

**Rate limiting uses fixed windows.** Sliding windows cost extra round trips on
every request and the gate path cannot afford them. Fixed windows can allow up
to 2x the limit across a boundary; on sensitive routes the limits are set low
enough that this remains safe.

**Uploads are validated by magic number**, not by the declared Content-Type. The
declared type is an attacker-controlled claim. Tests cover an ELF binary and an
HTML/script payload both claiming to be images.

**The HTTP kernel fails closed.** If the Phase 2 auth resolver is never
registered, every authenticated route rejects rather than running with an empty
context.

**Session replay stays off and telemetry is scrubbed on the way out.** Sentry and
New Relic receive request bodies and local variables; `core/observability/scrub`
strips NIN, tokens, connection-string credentials and Paystack keys from both
structured fields and free text before anything leaves the platform.

### Problems found and fixed

1. **Test env ordering bug.** `core/config` validates at import time, but the
   harness set its variables inside `beforeAll` — which runs after a test file's
   imports. Config refused to load. Moved to module top level, with a comment
   explaining why it must stay there.
2. **82 kB bundle regression.** `instrumentation-client.ts` imported
   `@sentry/nextjs` unconditionally, pushing First Load JS from 102 kB to 184 kB
   even with Sentry disabled. Replaced with a dynamic import guarded by the DSN
   check; back to 103 kB. This would have hurt the gate scanner most, which is
   the one screen that must stay fast on cheap tablets.
3. **`maxTimeMS` is not a connection option.** It was silently invalid on
   `mongoose.connect`. Reimplemented as a global query plugin so every read is
   bounded without each call site having to remember.
4. Several build-only lint failures from inline `import()` type annotations,
   which pass `tsc` but fail Next's lint. Converted to top-level type-only
   imports.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 238 tests, 13 files |
| `pnpm build` | pass — 103 kB First Load JS |

Notable coverage: 22 tenant-isolation tests run against a real MongoDB replica
set, not a mock, because the guarantee depends on how queries actually execute.
They assert that one estate cannot read, update, delete, count, paginate or
aggregate another's data, and that the boundary cannot be escaped via filter
injection, `estateId` reassignment or `$where`.

### Next

Phase 2 — Auth & identity: user/session/device schemas, argon2id hashing,
access and refresh tokens with rotation and reuse detection, OTP, TOTP 2FA,
lockout, and the registration flow through to admin approval.

