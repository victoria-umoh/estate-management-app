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

---

## 2026-09-18 15:30 UTC — Phase 2: Authentication & identity complete

### Architecture decision made up front

The spec asks for globally unique email, phone and NIN, *and* for multi-estate
readiness where one person may belong to several estates. Those two pull apart
if `estateId` sits on the user record.

Resolved by splitting them:

- **`users`** — global identity. Email, phone, NIN, password, 2FA. Uniqueness
  enforced here, once, across the platform.
- **`memberships`** — estate-scoped. Category, roles, approval state, property.
  One row per user per estate.

Login authenticates globally, then resolves which estates the account belongs
to. One estate signs straight in; several return a choice and issue no tokens
until one is picked. This also gave a clean answer to *where* users live: a new
`PlatformRepository`, deliberately named to stand out in review, for the small
set of collections that are not tenant-scoped by construction.

### What was built

argon2id password hashing with a policy that weights length over composition
rules; access JWTs plus opaque refresh tokens; session and device registry; OTP
and TOTP with backup codes; account lockout; pluggable NIN verification; and ten
API routes, each rate limited to its own risk profile — 5 registrations per IP
per 15 minutes, 3 OTP sends per user per 15 minutes, 5 NIN lookups per hour.

### Decisions taken

**Refresh tokens are not JWTs.** They are opaque random material, stored only as
SHA-256 hashes. A database dump yields nothing usable, and a leaked signing key
cannot mint long-lived sessions.

**Reuse of a rotated refresh token revokes the entire session family.**
Presenting a token that has already been rotated away means two parties hold it.
We cannot tell the thief from the legitimate holder, so both are evicted. This
signs the real user out — deliberately, and verified in tests.

**The context resolver does no database read.** The access token already carries
user, estate and permissions, and is short-lived precisely so it can be trusted
without a lookup. Adding a read would put a round trip on the gate path. The
cost is bounded and explicit: a revoked role takes effect at next refresh rather
than instantly. Where that is not acceptable — a blacklisted vehicle, a revoked
pass — the gate consults the credential store, which is authoritative.

**Failed logins burn equivalent argon2 work.** Without it, an unknown account
returns measurably faster than a wrong password, which is enough to enumerate
registered emails.

### Problems found and fixed

1. **My own timing defence was broken.** The decoy hash used for non-existent
   accounts was a hand-written constant — not a valid argon2 digest, so
   verification rejected it during parsing and returned almost instantly,
   burning none of the work it was supposed to burn. Now derived at startup from
   real key material, with a test asserting the decoy costs comparable time.
2. **Builds required production secrets.** Config validated at import, and a
   production build imports every route module, so `pnpm build` demanded the
   real encryption key. That is impractical for CI and pushes teams toward
   baking secrets into images. Config now validates lazily on first access, with
   `assertConfigValid()` at startup so a misconfigured deploy still dies at boot
   rather than mid-request. Verified: the build now succeeds with no secrets
   present at all.
3. **Auth wiring never took effect at runtime.** `registerAuthContextResolver()`
   ran in `instrumentation.ts`, but route handlers observed a different module
   instance, so every authenticated route returned "Authentication is not
   configured". Caught only by hitting a live server — every unit test passed.
   The kernel now self-bootstraps via dynamic import on first request.
4. **Device details were silently dropped.** The login DTO accepted `deviceId`
   and `deviceName`, but the service never forwarded them, so every session
   displayed as an unnamed device — useless for spotting an intruder. Also found
   by end-to-end testing, not by unit tests.
5. The tenancy guard rejected membership creation during registration, which was
   correct: there is no authenticated context at that point. Resolved with a
   system context scoped to the single estate being joined, rather than by
   weakening the guard.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 327 tests, 19 files |
| `pnpm build` | pass — 103 kB, and now builds with zero secrets |

End-to-end against a live server and a real database:

| Step | Result |
|---|---|
| Register | 201 |
| Weak password | 400, field-level detail |
| Duplicate email | 409 `DUPLICATE_IDENTITY` |
| Login before approval | 403 `ACCOUNT_PENDING_APPROVAL` |
| Login after approval | 200, tokens issued |
| Wrong password | 401, message identical to unknown account |
| Authenticated request | 200 |
| Forged token signature | 401 `TOKEN_INVALID` |
| Refresh | rotates to a new token |
| Replay old refresh token | 401 `SESSION_REVOKED` |
| Rotated token after reuse | 401 — whole family revoked |

The production config guards also demonstrated themselves: `pnpm start` refused
to boot against a development `.env.local`, naming each unsafe setting (mock NIN
verifier, in-process rate limits, local file storage, console mailer).

### Deferred, and why

- **Email verification and password reset** need the mailer, which lands in
  Phase 10. The OTP machinery they will use is built and tested.
- **Suspicious-login detection** needs the audit trail, which lands in Phase 3.

### Next

Phase 3 — RBAC & audit. The access token currently ships empty `roles` and
`perms` arrays, so no permission-gated route can pass yet. Phase 3 fills them.

---

## 2026-09-18 16:22 UTC — Phase 3: RBAC & audit complete

### What was built

A 119-permission registry, 11 system roles seeded per estate, the `can()`
authorisation core with privilege-escalation guards, and an append-only audit
trail. Access tokens now carry real roles and permissions — they shipped empty
through Phase 2, so no permission-gated route could pass until now.

### Decisions taken

**No system role holds `resident.viewNin` — not even the chairman.** Reading a
national identity number is a different act from reading a directory entry, and
running an estate does not require it. The permission exists and can be added to
a custom role deliberately; it is simply not granted by default to anyone.

**Security officers cannot see NINs, approve residents, or touch money.** The
gate is the estate's most physically exposed terminal: often shared between
shifts, frequently unattended, sometimes visible from outside. Its permission
set covers verifying, admitting, denying and recording movement, and stops
there.

**Roles are seeded per estate rather than shared globally.** A chairman can
inspect exactly what their own officers can do without that inspection reaching
another estate, and a future per-estate adjustment needs no schema change.

**System roles cannot be edited or deleted.** A chairman who stripped
`gate.operate` from the officer role would lock their own gates, and the failure
would present as a hardware fault rather than as a permission change. Custom
roles remain fully editable.

**Three guards on role creation**, because this is the main way a role system
fails — whoever can define roles can otherwise define one holding everything and
assign it to themselves:

1. The wildcard cannot be assigned to a custom role.
2. A role cannot be created at or above the creator's own rank. Strictly below,
   so authority cannot be cloned sideways either.
3. A role cannot grant a permission the creator does not already hold.

**Audit entries are immutable at three levels**: no update or delete path exists
in the codebase, the schema rejects mutation operations at the ODM layer, and
the deployment guide will instruct granting the application's database user
insert and find rights only. An administrator who can quietly erase evidence of
what they did is not an administrator anyone can audit. There is no `updatedAt`
field, because a field implying an entry could be updated would undercut the
whole point.

**Audit diffs redact sensitive fields to `[SET]` / `[CLEARED]`.** The trail must
record that a NIN changed without becoming a second database of NINs. Encryption
envelopes are collapsed rather than copied, since storing ciphertext in the
audit log is useless and gives it one more place to leak from.

### Problems found and fixed

1. **Wildcard check ran too late.** An attempt to mint `*` into a custom role
   was reported as "Unknown permissions: *" — because `*` is not in the registry
   — rather than as the escalation attempt it is. Reordered so the wildcard
   check runs first. The message matters: a security refusal that reads like a
   typo gets treated like one.
2. **The chairman could create and update roles but not delete them.** A custom
   role created in error could never be removed from the estate. Added
   `role.delete`.
3. My own test used an estate-manager to exercise the rank guard, but managers
   legitimately have no `role.create` at all, so the test was asserting the
   wrong refusal. Replaced with an actor that can manage roles but ranks below
   the chairman.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 398 tests, 22 files |
| `pnpm build` | pass — 103 kB, 12 API routes |

Coverage of note: role tests assert that a lower-ranked actor cannot create a
peer or superior role, cannot grant permissions it lacks, and cannot mint the
wildcard; audit tests assert that update and delete are rejected at the ODM
layer, that the repository exposes no write methods at all, and that a NIN
change is recorded without either value appearing anywhere in the entry.

### Still open

- **Suspicious-login detection** now has its data source — failed logins are
  audited with IP and user agent — but needs a notification channel to be useful.
  Lands with Phase 10.
- **Audit viewer UI** waits on the Phase 4 design system. The API is live.

### Next

Phase 4 — Design system & app shell. Primitives, states, the role-aware
navigation shell, motion, and the lazy 3D wrapper. The gate route group ships
without a 3D bundle.

