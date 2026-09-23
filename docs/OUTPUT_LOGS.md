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

---

## 2026-09-19 05:45 UTC — PORT configuration + Phase 4: Design system & app shell

### Requested: custom port via env

Added `PORT` and `HOST` to `.env.example` and the config schema.

Next binds its port *before* it loads `.env.local`, so a `PORT` written there is
ignored by `next dev` on its own — a genuinely confusing failure, because the
variable is clearly present and clearly not working. `scripts/next-with-env.mjs`
now loads the env file first and passes the value through as a CLI flag, which
is the one place Next honours it. A `PORT` already exported in the shell still
wins, matching Next's own precedence.

Verified: `PORT=3777` in `.env.local` binds 3777, and `/api/health` answers there.

### Phase 4: what was built

Primitives (button, input, badge, card, alert, table, dialog, skeleton), the
empty/error/permission-denied states, a confirm dialog, toasts, the theme
toggle, motion primitives, the lazy 3D wrapper, and a permission-filtered app
shell. A `/design-system` page renders all of it for visual checking.

### Decisions taken

**Status tones carry fixed meaning and are never conveyed by colour alone.**
Success is verified/paid/inside, warning is expiring or approaching a limit,
danger is denied/blacklisted/overdue, info is pending. Badges take a `dot`
variant so the state is legible without colour vision.

**The `lg` button is 44px tall and the gate uses it.** That interface is
operated on a tablet, often one-handed, sometimes in the rain.

**Type-to-confirm on irreversible actions.** Blacklisting a vehicle requires
typing the plate number. Friction is the point: these should not be possible to
do by reflex.

**3D scenes skip rather than degrade.** The wrapper renders its fallback outright
when WebGL is unavailable, the canvas is off-screen, reduced motion is set, or
the feature flag is off. A hero below the fold costs no WebGL context until
someone scrolls to it, and `dpr` is capped at 2 so a high-DPI phone does not
render four times the pixels it needs for a decorative background.

**Motion collapses to instant under `prefers-reduced-motion`** — the primitives
render a plain `div` rather than running a faster animation, so no motion
machinery executes at all.

**Navigation is permission-filtered in the shell, and every route still enforces
server-side.** Hiding a link someone cannot use keeps the interface honest; it
is not what keeps them out.

### Problem found and fixed

**Alert text was nearly invisible in three of four tones.** I used the tone's
`*-foreground` token as the body text colour on a `*-muted` background. Those
tokens are near-white — they are the text colour for a *solid* tone fill. On a
pale background they rendered at almost no contrast. Only warning read
correctly, because its foreground token happens to be dark, which is exactly the
kind of coincidence that hides a bug.

Caught by screenshotting the page rather than by asserting the markup existed.
Body text is now `text-foreground`, with tone carried by the border, icon and
title.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 398 tests, 22 files |
| `pnpm build` | pass — shared First Load JS still 103 kB |

Visual, via Playwright screenshots of `/design-system`:

| Check | Result |
|---|---|
| Light, 1280px | pass |
| Dark, 1280px | pass |
| Mobile, 320px | pass |
| Horizontal overflow at 320px | 0px in all three |

The shared bundle staying at 103 kB matters: Framer Motion and Three.js are
per-page, not shared, so the gate route will not pay for either.

### Deferred, and why

- **Command palette** needs real data to search over. Lands in Phase 11 with
  global search.
- **Audit viewer UI** likewise — the API is live, the screen belongs with the
  other reporting surfaces in Phase 11.

### Next

Phase 5 — Estate core: estates and settings, properties with ownership and
tenant history, resident profiles, households, and the tenant lifecycle.

---

## 2026-09-19 07:25 UTC — Bundle budget guard + Phase 5 (part 1): Estates & properties

### Requested: stop the shared bundle drifting

Added `bundle-budget.json` and `scripts/check-bundle-budget.mjs`, wired into
`pnpm build` so it cannot be skipped. The script reads the production manifest,
gzips each emitted chunk, computes the set of files every route loads, and fails
the build when a budget is exceeded — naming the largest shared chunks so the
cause is obvious rather than a hunt.

**It caught a real leak on its first run.** Shared was 111.2 kB against a 110 kB
budget, and the offending chunk was 10.2 kB of **Sonner plus next-themes**,
sitting in the root layout and therefore in the first load of *every* route —
including the API routes and the future gate scanner, none of which will ever
show a toast on first paint.

Moving the Toaster behind `dynamic(..., { ssr: false })` brought shared to
**103.8 kB — 7.4 kB saved on every single page**. The budget is now set to
106 kB: roughly 2% headroom, which is thin enough that any real library (all of
them are more than 5 kB gzipped) trips it immediately, while a React or Next
patch release does not.

### Phase 5, part 1: estates and properties

Estates, their operational settings, and properties with full occupancy history.

### Decisions taken

**Occupancy is its own append-only collection, not fields on the property.**
Relationships end while the property persists: owners sell, tenants move out,
leases lapse. Gate logs, invoices and incident reports from a past tenancy all
point back at that relationship, and a dispute six months later is exactly when
it matters. Ending a tenancy closes the record; it never deletes it.

**One current holder per role is enforced by a partial unique index**, not by
application logic. Checking in code would let two concurrent transfers both
succeed and leave a property with two owners.

**Ownership transfer is distinct from ordinary assignment**, because a sale can
also end the sitting tenancy — a buyer inherits the property, not the seller's
agreements. It is opt-in (`endExistingTenancies`), and the audit entry records
both parties and the unit number explicitly, since this is among the
highest-consequence actions in the system. The route is idempotent, so a retry
after a timeout cannot create a second ownership record.

**Overcrowding is logged, not blocked.** Registering more occupants than a
property's stated maximum produces a warning rather than a refusal: blocking it
would push the arrangement off-system entirely, and an estate that cannot see
overcrowding cannot address it.

**Estate creation seeds roles in the same operation.** An estate without roles
has no chairman, no officers and no way to admit anyone — it would exist but be
unusable, and the failure would surface later as a confusing permissions problem
rather than as a failed signup.

### Problem found and fixed

**The in-memory MongoDB harness timed out at 10s** on a loaded machine, failing
whole suites with `Instance failed to start` — which reads as a code fault
rather than a slow start. My first fix set `MONGOMS_STARTUP_TIMEOUT`, which is
not a real configuration key and did nothing; the timeout is an *instance*
option. Now set properly via `instanceOpts: [{ launchTimeout: 60_000 }]`.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 433 tests, 24 files |
| `pnpm build` | pass |
| `pnpm budget` | pass — shared 103.8 kB / 106 kB |

Property tests cover: history preserved across transfers, the full ownership
chain retained, exactly one open record per role, tenancies optionally ended by
a sale, lease-expiry windows, and that another estate can neither read nor
transfer a property.

### Next

Phase 5, part 2 — the resident directory, households and dependants, the tenant
invitation flow, and the sensitive-field change-approval workflow.

---

## 2026-09-19 07:52 UTC — Phase 5 (part 2) complete: Residents, households, change approval

### What was built

The resident directory, dependants and households, and the approval workflow for
resident details that cannot be edited freely.

### Decisions taken

**Three separate resident view shapes, each an explicit allow-list.** The
directory carries no contact details; a profile carries them with the NIN
masked; a gate screen carries a name, category, unit and photo and nothing else.
The difference between them is a security boundary, not a convenience, so none
of them is built by spreading a database document — a field added to the schema
later cannot leak by being forgotten.

**Dependants are their own collection, not stub `users` rows.** A five-year-old
has no email, no phone and no password. Manufacturing an account for one would
put a permanently unverifiable, unloginable row into the identity collection —
the one place where every row is meant to be a verified person. Dependants still
get a profile and can be issued an ID, because the gate needs to recognise them,
and `linkedMembershipId` connects them to a real account later without rewriting
history.

**A resident may manage only their own household.** `household.create` on its
own would otherwise let any resident add a dependant to a neighbour's house —
and a dependant is someone the gate will admit. Staff who can approve or update
residents may manage any household.

**A change request cannot be reviewed by the person who submitted it.** Without
that, a member of staff holding both `resident.update` and `resident.approve`
could change their own NIN, or move themselves to another property, entirely
unobserved. Proposing and approving are different acts by different people.

**Availability is re-checked at approval, not only at submission.** A competing
account may have taken the phone number or NIN while the request sat in the
queue. On a clash the request stays pending rather than being marked approved
with nothing applied.

**Approving a NIN or phone change clears its verification.** Carrying the old
verification across to a new value would be a lie, and a phone number is a
password-reset path.

### Problems found and fixed

1. **My own masking was fabricating data.** `detail()` computed
   `maskNin('00000000000')`, which renders `•••••••0000` — output that looks
   like a real masked NIN but whose last four digits are invented, which is
   worse than showing nothing. Now backed by a real `ninLast4` field, stored in
   the clear: four digits of eleven leave ten million combinations, so they
   identify nobody on their own, and they are precisely what masking exists to
   provide — letting staff match a physical slip without decrypting anything.

2. **The audit redaction filter blanked a boolean.** A metadata flag named
   `hasNin` was redacted because the filter matches field names loosely. Over-
   redacting is the correct default for an audit trail, so the field was renamed
   to `identityProvided` rather than the filter weakened — with a comment so the
   next person does not fight it.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 487 tests, 27 files |
| `pnpm build` | pass |
| `pnpm budget` | pass — shared 103.8 kB / 106 kB |

Coverage of note: the directory never contains a NIN even masked; the gate
identity shape is asserted key-by-key so a future addition to it fails the test
rather than silently reaching the gate; every NIN reveal is audited, including
failures, without the value ever entering the trail; and a submitter cannot
review their own request.

### Deferred, and why

**The tenant invitation flow** needs the mailer to actually invite anyone. The
underlying pieces — tenancy records, approval, occupancy history — are all
built and tested; only the invitation message is missing. It lands with Phase 10.

### Next

Phase 6 — Digital ID and vehicles: Estate ID generation, the signed rotating QR,
the `access_credentials` denormalised gate fast path, and vehicle registration
with blacklisting.

---

## 2026-09-21 19:46 UTC — Phase 6: Gate credentials, fast path and vehicles

### What was built

The `access_credentials` store, the gate verification path, vehicle
registration with blacklisting, and a benchmark that proves the latency claim
rather than asserting it.

### The gate path

Ordering is the whole design:

1. **Verify the signature.** Pure crypto, no I/O. A forged or corrupted scan is
   rejected without touching the cache or the database, so someone spraying junk
   at a gate cannot generate load. The estate is read from the token too, so a
   cross-estate scan also costs nothing.
2. **Check the cache.** One key lookup.
3. **One indexed read** on `tokenHash`, with an explicit projection. No joins,
   no populate, no second round trip.

`access_credentials` is deliberately denormalised — everything the gate screen
renders is copied in at issue time. The cost is staleness, so domain events keep
copies in step and `syncedAt` records when each row was last reconciled, making
drift visible rather than silent.

### Decisions taken

**Rows are keyed by the SHA-256 of the token, never the token.** A database dump
yields no working passes. The token is returned exactly once at issue; a lost
pass is reissued, not retrieved.

**Blacklist is evaluated before status.** A stale cached status must never admit
someone who has been blocked.

**Only admissible credentials are cached.** Caching a denial saves nothing worth
the risk, and a cached blacklist could outlive the block being lifted.

**Every state change invalidates the cache key.** Revoking, suspending or
blacklisting drops the entry immediately — otherwise a blocked pass keeps
working until the TTL lapses, which is the difference between revocation taking
effect now and in half a minute.

**Vehicles register as `pending` and only receive a credential on
verification.** Until someone has checked the papers, a vehicle has no business
opening a gate. Blacklisting blocks the vehicle and its credential in one
operation, because the gate reads credentials, not vehicles.

**A duplicate-plate error names the plate, not the owner.** Confirming who holds
a registration would let anyone enumerate residents by trying plates.

### On measuring rather than claiming

`pnpm bench:gate` seeds 5,000 credentials into a real replica set and measures
cold, warm and forged scans:

| Path | p50 | p95 | p99 | Budget |
|---|---|---|---|---|
| cold (database read) | 0.31 ms | 0.53 ms | 0.73 ms | 8 ms |
| warm (cache hit) | 0.00 ms | 0.00 ms | 0.01 ms | 2 ms |
| forged (no I/O) | 0.00 ms | 0.00 ms | 0.01 ms | 2 ms |

My first budgets were 25 ms and 5 ms — roughly fifty times the observed value,
which would catch nothing. Tightened to leave room for a slower CI machine and
little else.

More importantly, a timing budget is the wrong instrument for the failure I most
care about. Losing the index would be catastrophic — every scan reading every
credential in the estate — but a timing check only catches it if the collection
happens to be large enough on the day. So the benchmark also asserts the query
plan uses **IXSCAN**, which catches it deterministically. I verified that guard
fails as intended by pointing it at an unindexed field and confirming it
reported `COLLSCAN`.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 527 tests, 29 files |
| `pnpm build` | pass |
| `pnpm budget` | pass — shared 103.8 kB / 106 kB |
| `pnpm bench:gate` | pass — IXSCAN confirmed, all budgets met |

Tests assert that forged, malformed, expired and cross-estate scans each perform
**zero database queries** (verified by spying on the model), that revocation
takes effect on the next scan rather than on cache expiry, and that a
blacklisted credential is refused even when its status still reads active.

### Still open in Phase 6

**The digital ID card UI** — QR render, the 3D flip, and the printable PDF. The
credential and token machinery behind it is complete and tested; what remains is
the surface. Resident credential issuance on approval is deliberately held with
it, so the two land together rather than issuing credentials nobody can see.

### Next

Phase 7 — Gates, visitor passes, entry/exit logging and overstay detection.

---

## 2026-09-21 20:13 UTC — Phase 7: Gates, visitor passes, movement log, overstay sweep

### What was built

Gates, visitor and walk-in passes, the immutable movement log, the full gate
workflow, and the overstay sweep. The spec's visitor and overstay workflows now
run end to end and are tested as such.

### Decisions taken

**Expected and walk-in passes share one collection.** Once issued they behave
identically, so the gate, the sweep and the reports each handle one shape rather
than two. What actually differs — who created it, and whether a host approved
it — is recorded on the row. `hostApproved` matters: an officer admitting
someone because they reached the resident and an officer admitting on their own
judgement are different acts, and only one is defensible afterwards.

**Visitor codes exclude O/0, I/1 and S/5.** The code is read aloud over a phone,
copied from a screenshot, and typed by an officer in poor light. A code that is
technically unique but practically confusable costs more than the entropy it
saves.

**Movements are recorded for denials as carefully as for admissions.** The
denials are what an investigation is usually looking for — a pattern of refused
scans at 3am is the signal worth having — and an officer cannot be expected to
log them separately while someone is arguing at the barrier.

**The movement log keeps its own copy of who passed through.** `subjectLabel`,
unit number and plate are captured at the moment of the event rather than
referenced. If a pass is later deleted or a resident leaves the estate, the log
must still say who came through; one that resolves to "unknown" is no use as
evidence. Tested by deleting the pass and asserting the movement still names the
visitor.

**Checkout revokes the credential**, so a spent code cannot admit a second visit
the same day. If that revocation fails it is logged loudly but does not fail the
checkout — leaving a visitor recorded as still inside would be worse than a pass
that stays technically valid until it expires.

**Overstay is raised once per pass.** Without `overstayNotifiedAt`, a sweep
every five minutes would message the host every five minutes, and a host being
pestered stops reading the alerts entirely — which costs more than the overstay
did. Each estate's own grace period is honoured in a single pass across all
estates.

**The cron route authenticates with a length-safe secret comparison** and sits
outside the `/api/v1` kernel deliberately: it has no session and is not a
user-facing API. Without the secret, anyone who found the URL could trigger
sweeps at will.

### Problem found and fixed

**The route kernel rejected any schema using `.transform()` or `.default()`.**
`z.ZodType<T>` binds input and output to the same type, so a query schema that
coerces a string to a number — exactly the coercion that belongs at a route
boundary — failed to typecheck. I had already worked around this once in Phase 6
by dropping a `.default()`; hitting it a second time made clear the kernel was
wrong, not the call sites. Widened the generics to `z.ZodType<T, ZodTypeDef,
unknown>` and restored the workaround.

Also removed dead code from the overstay query: I had computed a "widest grace"
bound, not used it, and silenced the unused variable with `void`. The correct
bound is the *narrowest* grace across estates — no pass can be overstaying under
any estate's rules before then — so the query now uses that and actually
narrows.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 555 tests, 30 files |
| `pnpm build` | pass |
| `pnpm budget` | pass — shared 103.9 kB / 106 kB |
| `pnpm bench:gate` | pass — IXSCAN confirmed, cold p95 0.39 ms |

The spec's workflows are tested as workflows, not only as units: resident
creates a pass → visitor arrives → security scans in → visitor shows as inside →
scans out → visit completed, with both movements recorded. And: pass expires →
visitor still inside → grace exceeded → sweep raises it once → host notified via
event → audit entry written.

### Next

Phase 8 — incidents, emergencies and service requests. The deferred UI work (the
digital ID card and the gate scanner screen) is still outstanding and should
follow, since both now have complete APIs behind them.

---

## 2026-09-21 21:41 UTC — Phase 8: Incidents, emergencies and service requests

### What was built

Three modules that share a shape — report, assign, resolve, close — and differ
in the places that matter.

### Decisions taken

**An emergency requires only a type.** Description, location, coordinates and
contact number are all optional. This record is created by someone in trouble,
possibly one-handed, possibly on behalf of someone else, and a validation error
at that moment is a failure of the product rather than of the caller. The rate
limit is generous for the same reason: a duplicate alert is an annoyance, a
refused one is not.

**Response time is stored, not derived.** It is the figure an estate will be
judged on, and deriving it would mean a later correction to a timestamp could
quietly improve a past number.

**A false alarm is an outcome, not a deletion.** A resident who fears being
blamed for one is a resident who hesitates next time, and the hesitation is the
real danger.

**Incident `closed` is terminal.** Reopening means raising a new incident that
references the old one, so the original timeline stays intact — a record that
can be edited after a dispute starts is not much of a record.

**Involved persons and vehicles accept free text.** "A tall man in a blue shirt"
is often the most accurate thing a reporter can say, and requiring a resident id
would discard the only description anyone has.

**Internal comments are staff-only, and a resident cannot mark their own comment
internal** — doing so would hide it from the very people handling their case.

**A service request's SLA target is fixed on the row at creation.** Changing the
policy later must not retroactively re-date existing tickets, which would shift
an estate's reported performance for work already done.

**Only the requester may rate a ticket.** A ticket closed and rated by the
person who did the work is exactly how "resolved" quietly diverges from "fixed".

### Problem found and fixed

**Incidents sorted by severity alphabetically.** The list query sorted on the
`severity` string descending, which orders `medium > low > high > critical` —
so a critical incident would sit *below* a noise complaint, which is precisely
the failure the sort existed to prevent. Caught by a test asserting a critical
incident appears above a low one.

Fixed with a numeric `severityRank` kept in step by the service and used for
ordering. The mapping lives in one place, and the index was updated to match.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 595 tests, 31 files |
| `pnpm build` | pass |
| `pnpm budget` | pass — shared 103.9 kB / 106 kB |

### Where the project stands

Every backend domain in the original brief now has a tested API. What does not
exist is the **interface** — and that is now the whole gap. The gate scanner in
particular is the screen the entire latency design was built for, and it has no
surface at all.

I would build the gate scanner, the digital ID card and the security dashboard
together rather than separately: they share the credential display, the status
badges and the scan result components, and doing them in one pass avoids three
separate design passes over the same material.

### Next

The consolidated security and identity UI.

---

## 2026-09-22 02:10 UTC — Phase 9: Security & identity UI

### What was built

The gate scanner, the security desk, the digital ID card, a login page, the
authenticated shell — and, underneath all of it, a safe way for a browser to
hold a session.

### Cookie sessions

Before any screen could be built, the web client had no safe place to keep a
credential. Login now returns tokens in the body *and* sets them as httpOnly
cookies when the caller identifies as `web`; the browser client never sees a
token at all. Native clients keep using the body, unchanged.

Two details worth recording:

- **The refresh cookie is scoped to `/api/v1/auth`.** A refresh token has no
  business being attached to every API request it does not authenticate.
- **`SameSite=Lax`, not `Strict`.** Strict would drop the session on any inbound
  link — including the one in a visitor-pass email — and sign the resident out
  for no security gain, since every mutating endpoint takes a JSON POST that a
  cross-site form cannot produce.

The route kernel now passes a `NextResponse` through untouched when a handler
returns one, which is how cookies get attached without loosening the envelope
for everything else.

### Decisions taken

**The gate scanner carries nothing decorative.** No 3D, no route animation. The
QR decoder (~200 kB) is dynamically imported so only that screen pays for it.
Gate and direction are chosen once and remembered, because an officer works one
gate for a whole shift. Camera failure falls through to code entry and plate
lookup rather than stopping the queue.

**The scan result is designed to be read in under a second**, at arm's length,
in sunlight. Colour, icon and a short verb all carry the same message, because
an officer glancing up may resolve only one of them. A blacklist gets a solid
fill rather than a tint: "pass expired" and "do not admit this person" call for
very different responses and must not look alike.

**The ID card flip is a CSS 3D transform, not a WebGL scene.** Loading a
renderer to turn a rectangle over would cost hundreds of kilobytes for something
the compositor does natively — on a card opened at a gate, on a phone, on a poor
connection.

**The security desk is ordered by urgency, not by module**: emergencies, then
overstays, then who is inside, then the log. It polls rather than holding a
socket, because a gate tablet drops its connection regularly and a poll that
silently resumes beats reconnection logic nobody will watch. A failed poll never
wipes a screen the officer is already reading.

### Problems found and fixed

1. **`systemContext` used the string `'system'` as a user id.** Services that
   record an actor — `issuedBy`, `recordedBy` — construct an ObjectId from it
   and crashed. This broke *every* job and seeder the moment it touched one of
   those fields. Now a real sentinel ObjectId, with the audit trail still
   printing "system" so the log stays readable.

2. **The tsx scripts never loaded `.env.local`.** `pnpm seed`, `pnpm job:*` and
   `pnpm bench:gate` would all have failed config validation with a message that
   reads like missing configuration rather than a missing loader. Fixed with a
   preload module applied to every tsx script.

3. **The tight gate bundle budget was never being enforced.** My budget keys
   were `/security/scan`, but the build manifest uses `/(app)/security/scan`, so
   every route silently fell through to the 260 kB default. Keys corrected and
   the file now says so, because a budget that looks configured and is not is
   worse than none.

4. The ID card route imported a repository directly; the layering rule caught
   it. Fixed by adding `residentService.ownIdentity`, which asserts the
   membership belongs to the caller and reports someone else's as *not found*
   rather than forbidden — so it cannot be used to discover which ids exist.

### On testing the UI

Compilation proves nothing about whether an officer can admit a visitor.
`scripts/ui-walkthrough.mjs` drives a real browser against a real database:

| Check | Result |
|---|---|
| Signs in and reaches the dashboard | pass |
| Sets an httpOnly session cookie | pass |
| Stores no token in browser storage | pass |
| Gate scanner loads | pass |
| Admits a valid visitor code | pass |
| Shows the visitor name | pass |
| Refuses an unknown code | pass |
| Security desk shows the visitor inside | pass |
| Security desk shows gate activity | pass |
| No horizontal overflow at 320px | pass |
| No horizontal overflow at 820px | pass |

Two things that looked like product bugs were not. A chairman could not operate
the gate — correct, since `gate.operate` belongs to the security officer role;
the seed was assigning the wrong role. And a second run refused to admit an
already-admitted visitor — also correct; the harness was reusing a seed. It now
seeds inside the run.

### Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass — 595 tests, 31 files |
| `pnpm build` | pass |
| `pnpm budget` | pass — shared 103.9 kB / 106 kB; scan 127.2 / 135 kB |
| `scripts/ui-walkthrough.mjs` | pass — 11 checks |

### Next

The resident portal — visitor passes, household, vehicles, payments — and the
finance module.


---

## 2026-09-23T08:45Z — Phase 10: Money (fees, invoices, ledger, payments)

### Delivered

**Double-entry ledger** (`src/modules/finance/ledger.schema.ts`, `ledger.service.ts`)
Append-only: `updateOne`, `updateMany`, `findOneAndUpdate`, `deleteOne` and
`deleteMany` all throw at the ODM layer. A correction posts a reversing entry;
history is never edited. `post()` refuses an unbalanced transaction, a
single-sided one, a zero one, and fractional minor units. `verifyIntegrity()`
reports whether total debits equal total credits — surfaced on the finance
screen, because it is the figure that says whether every other figure can be
trusted.

**Invoices** (`invoice.service.ts`)
draft → issued → partially-paid / paid / overdue / cancelled. A draft has no
accounting effect; issuing is the separate act that posts AR debit / revenue
credit, inside the same transaction as the status change. Cancelling reverses
the posting and is refused once any payment exists — the correction there is a
refund, since cancelling would erase the debt while the estate kept the cash.
Line totals are computed once and stored, so changing a fee never restates
invoices already sent.

**Payments** (`payment.service.ts`, `src/integrations/payments/`)
Paystack behind a `PaymentProvider` interface, with a mock that signs webhooks
using the same HMAC-SHA512 scheme so the signature path is genuinely exercised
rather than stubbed past. The pending row is written *before* the provider is
called, so a payment taken while the browser is closing still has a row to
attach to.

**Billing run** (`src/jobs/billing-run.ts`, `pnpm job:billing`)
Generates invoices for every recurring fee that falls due. The fee period is
part of the invoice's unique index, so a retried run collides rather than
double-charging. Failures are per-membership, not per-run. `pnpm job:overdue`
flags arrears separately.

**API** — `/api/v1/fees`, `/invoices`, `/invoices/:id/issue`, `/invoices/:id/cancel`,
`/payments/initialize`, `/payments/verify`, `/payments/manual`, `/ledger`,
`/me/invoices`, and `/api/webhooks/paystack` (raw body, outside the kernel).

**UI** — `/admin/finance` (trial balance, invoices, fees) and `/my/payments`.

### Decisions

| Decision | Why |
|---|---|
| Integer minor units (kobo) everywhere | Floating-point money accumulates error that only becomes visible once totals are large enough for someone to notice — the worst time to find it. |
| Webhook re-verifies the amount against the provider API | A valid signature proves the message came from Paystack, not that the body was not replayed from a smaller charge. The webhook body's amount is never trusted. |
| Webhook event id claimed under a unique index before any work | Providers retry, especially when something went wrong, so duplicate delivery is routine rather than exceptional. |
| Browser-side confirmation is never trusted | The post-checkout redirect is a URL the payer controls. `/payments/verify` only looks the payment up and asks the provider; the webhook remains authoritative. The resident page says so in copy rather than leaving them to guess. |
| `payment.verify`, not `payment.create`, gates manual cash entry | Recording cash credits an account on nothing but a person's word, and is the obvious route to writing off a debt quietly. |
| Webhook returns 500 on a processing failure | A 500 makes Paystack retry. The alternative is acknowledging a payment we failed to record. |
| Unsigned/forged webhook returns 401, not 400 | Nothing about our state should be inferable from the response. |

### Bug found and fixed during verification

**Residents could read every household's invoices.** `invoice.view` was doing
double duty: residents hold it so they can see their own dues, but
`GET /api/v1/invoices` treated it as an estate-wide read. A resident calling
that route with no filter got every household's billing history.

Found by exercising the API over HTTP as the seeded resident — the unit tests
all passed, because each one asserted a permission it had itself chosen.

Fixed by splitting the permission, following the `resident.viewNin` precedent:
`invoice.view` is now the resident's own invoices, and `invoice.viewAll` gates
the estate-wide list and `outstandingFor()`. Granted to chairman and finance
officer only. Three regression tests added.

Related: `/me/invoices` resolves the membership from the session and never
accepts one from the request, so the resident page cannot be pointed at another
household by changing one value in the browser. The ESLint layering rule caught
the first version of that route calling repositories directly.

### Also fixed

**The demo seeder could only ever run once.** Demo accounts use fixed addresses
(`admin@example.com`) which are unique platform-wide, so a second run died on a
raw duplicate-key stack trace. Added `pnpm seed:demo --reset`, which clears the
previous demo estate first — scoped by estate name, so it cannot touch a real
tenant sharing the database.

### Gates

typecheck clean · lint clean · **629 tests passing** (34 new) · build clean ·
shared First Load JS **103.9 kB**, unchanged — finance did not leak into the
shared chunk, so the gate route still pays for none of it.

### Verified over HTTP, not just in tests

```
ADMIN     ledger balanced = true | receivable 6,950,000 | cash 5,000,000
          invoices INV-00003 overdue, INV-00002 issued, INV-00001 paid
RESIDENT  own dues  3 invoices, 6,950,000 outstanding
          /invoices FORBIDDEN    /ledger FORBIDDEN    /fees FORBIDDEN
WEBHOOK   unsigned 401           forged signature 401
```

Billed 119,500 = collected 50,000 + outstanding 69,500.

### Environment note

Partway through this phase MongoDB Atlas began refusing connections from this
machine. DNS resolves and all three shard nodes are reachable by name, but every
one refuses TCP on 27017 — which is Atlas rejecting a non-allowlisted IP at the
network layer. The egress IP is now `185.28.254.227`; it had been working
25 minutes earlier, so something changed (VPN or DHCP).

The preview was moved to the local replica set so it still runs. `.env.local`
carries a clearly-marked temporary block; delete it once the IP is added under
Atlas → Network Access, and un-comment the Atlas line above it.

---

## 2026-09-23T10:00Z — Phase 11: Closing the gap between the API and the app

### Why this phase existed

An audit of the running app against its own navigation found the reported
progress was wrong. The backend was roughly where I said it was; the application
was not:

| | Built | Promised |
|---|---|---|
| App screens | 6 | 24 in the nav → **18 dead links** |
| Permissions enforced | 68 | 120 declared → **52 gating nothing** |
| Tests | 629 passing | all backend; **zero exercised a screen** |

Ten phases had been reported complete on the strength of "the service can do it
and the tests are green". The bar was wrong. A user experiences this product
through the UI, and most of the UI did not exist.

### Built — 17 screens

Residents (list + detail, approve/reject, audited NIN reveal) · Properties
(list + detail, occupancy history, transfer) · Vehicles (list, blacklist) ·
Incidents (list + detail) · Service requests · Gate activity · Emergencies ·
Audit trail · Roles · Estate settings · My visitors · My household ·
My property · My vehicles.

Built in parallel by five subagents against a shared brief, with strict file
ownership so no two could touch the same file.

### Built — 14 API routes that were missing

The subagents' most valuable output was not the screens; it was discovering that
**services implemented full lifecycles that had never been exposed over HTTP**.
`incidentService` had assign, setStatus, resolve, close, escalate and comments —
all with permission checks and audit records already written, none reachable.
Same for service requests. The screens could not have worked no matter how they
were built.

Added: incident detail + assign/status/resolve/escalate/close/comments, service
request detail + assign/status/resolve/close, `PATCH|DELETE /roles/:id`, and the
`/me/*` family (profile, property, vehicles, household, visitors).

### Bugs found by driving the app rather than testing the services

**1. The finance screen was broken.** It read
`api.get<{items: Invoice[]}>('/invoices')`, but `paginated()` puts the array
directly in `data`. Shipped last phase, verified over curl, never once loaded in
a browser. Two subagents caught it independently.

**2. `meta` was unreachable by any client.** `api.get` returned only `data`, so
`page`/`total`/`hasNextPage` were discarded. Every list screen was inferring
"there is more" from a full page coming back — a wasted request at every exact
multiple of the page size, and no totals anywhere. Added `api.getPage()`.

**3. Two screens depended on a `localStorage` key nothing ever wrote.** The
digital ID card and the emergency responder actions both read
`localStorage.getItem('membershipId')`. Nothing in the codebase ever set it, so
the ID card never loaded and the emergency actions were permanently disabled.

The fix was not to write the key. `POST /emergencies/:id` was taking
`responderMembershipId` from the request body — which let a client claim someone
else had attended an emergency, the one record that matters most afterwards.
The responder is now resolved from the session, and the browser no longer needs
to know its own membership id at all.

**4. No idempotency key could be sent.** Routes declaring `idempotent: true`
read an `idempotency-key` header that `api.post` had no way to set, so a retried
transfer or payment after a timeout was processed as a second request.

### The structural fix: `/me/*` and `MeService`

The invoice leak last phase, the emergency responder field, and the phantom
`membershipId` were three faces of one mistake: **letting the client say who it
is**. `MeService` is now the single place that answers it, from the session,
and every resident-facing route goes through it. The underlying services keep
their own `assertMayActFor` checks — this is a second line, not a replacement.

### Navigation now tells the truth

Four items (Announcements, Notifications, Exit passes, Reports) have no backend
at all. Rather than delete them — the nav doubles as the statement of what this
product is — they carry a `planned` flag and are filtered out of the rendered
menu. Nobody clicks through to a 404, and the intent is still recorded.

### `pnpm smoke` — the check that was missing

A harness that signs in as each of the three roles and drives **every screen
over HTTP with a real session cookie**, plus every GET endpoint, plus the
permission and webhook regression guards.

This is the gate that would have caught all four bugs above, and the finance
leak last phase. It is now the bar for "done": not "the service can do it" but
"the screen loads, signed in, as the role that uses it".

```
Screens     20/20 ok      Endpoints   21/21 ok
Refused      4/4  ok      Webhook      2/2  ok
```

Note `client: 'web'` on login is what sets the session cookies; without it only
bearer tokens come back. The first version of the harness missed this and
reported all 20 screens as broken — a harness bug, not an app bug, but a useful
reminder that a red result deserves the same scepticism as a green one.

### Decisions

| Decision | Why |
|---|---|
| Actor identity always from the session, never the body | Three separate bugs this phase traced to the client asserting who it was. |
| `DELETE` closes an incident, it does not delete one | An incident is the record a dispute is answered with. |
| Emergency identity fields return ids, not names | Resolving names needs a per-alert join, and that does not belong on a life-safety hot path. |
| Unbuilt nav items flagged, not deleted | The nav is also the product's statement of intent; a 404 is worse than a shorter menu. |
| Added `{estateId, direction, occurredAt}` index | The new direction filter otherwise scans and discards, fine on a recent page and not on a date range. |

### Open questions for the owner

**Residents can read the estate directory** (`/residents` → names, categories,
unit numbers, no contact details) because the homeowner role holds
`resident.view` for tenant management. Defensible as a community directory, but
it is the same permission the gate uses. The smoke test now guards the boundary —
it fails if that projection ever grows a phone number or identity field.

**Residents can read any incident's detail**, not only their own, because the
resident role holds `incident.view`. The comment threads are correctly scoped
(reporter-or-staff); only the detail read inherits this. An RBAC decision, not a
routing one.

### Gates

typecheck · lint · 629 tests · build · bundle budget (shared First Load JS
unchanged at **103.9 kB**) · **`pnpm smoke` 47/47**.

---

## 2026-09-23T14:30Z — Phase 12: Notifications, passes, search, SaaS, marketing

Run with seven subagents under strict file ownership, against a shared brief.

### The measurable change

| | Before this session | Now |
|---|---|---|
| App screens | 6 | **23** |
| API routes (`/api/v1`) | 42 | **90** |
| Permissions gating nothing | 52 of 120 | **8 of 121** |
| Tests | 629 | **738** |
| Dead navigation links | 18 | **0** |
| Shared First Load JS | 103.9 kB | **104.1 kB** |

The eight remaining unenforced permissions are four soft-delete variants (this
system does not hard-delete), `user.update`, and the three platform/super-admin
permissions whose console is not built.

### Delivered

**Notifications & announcements** — Resend and Termii adapters behind
interfaces with a recording console fallback; twelve typed templates held in
code; per-resident channel preferences; announcements with audience targeting
and publish fan-out; six event handlers wired at bootstrap.

**Exit & temporary passes** — the last spec features that had permissions and
no code. Exit passes carry an item manifest and lock it at approval. Temporary
passes are reusable within a bounded window and deliberately have no terminal
"used" state.

**Global search** — residents (name, code, phone and NIN by blind index),
plates, pass codes, tickets, incident references, invoices, payments,
properties. Permission-filtered per result type, with a ⌘K palette.

**SaaS layer** — plan definitions, the entitlement seam in the route kernel,
subscriptions with trial/grace/suspension, and the marketing site with a
pricing page driven by the same plan definitions the server gates on.

**Dashboard** — replaced the placeholder with per-caller blocks.

### Decisions

| Decision | Why |
|---|---|
| Entitlement seam built now, gating nothing yet | Retrofitting across 90 routes is how one gets missed, and a missed check is a paid feature served free with no test to catch it. |
| Grace and suspension stop writes, not reads | An estate that forgets to pay must not lose its gate. Residents queuing at a barrier that will not open is a safety problem, not a billing one. |
| Emergency and security notifications cannot be muted | A resident who silenced "alerts" six months ago must still be told their gate reported an emergency. Enforced in the service, before preferences are read. |
| Exit-pass manifests lock at approval | A list the person being checked can still edit is not evidence. A mistake is corrected by cancelling and raising a new pass, leaving both on the record. |
| `approvalRequired` snapshotted onto each pass | An estate that turns approval off next month must not retroactively make an unapproved removal look authorised. |
| Templates live in code, not the database | A template editable at runtime is a template that can be edited into an injection. |
| Search mirrors each list endpoint's permission exactly | Search must never be a wider door than the screen it links to. |
| A NIN search is audited and needs `resident.viewNin` | Someone who cannot reveal a NIN must not confirm one exists by searching for it. |
| One short-code alphabet, shared | Three pass types are typed into the same field by the same officer on the same handset. A second alphabet is how the O/0 problem returns. |

### Decided by the owner this session

**Incidents are now narrowed.** Residents held `incident.view`, and the
estate-wide list and detail were gated on it — so any resident could read the
full description and named parties of every incident on the estate. Split into
`incident.view` (yours) and `incident.viewAll` (the estate). The list narrows
rather than refuses, since following your own report is why a resident holds it;
the detail of someone else's incident is a **404, not a 403**, because
confirming it exists still tells you it happened.

**Chairmen still cannot revoke temporary passes** — left as-is by decision.
Separation of duties: the chairman sets policy, security operates the gate.

### What the smoke test caught that unit tests did not

- The finance screen read `data.items` off a response that is a bare array.
- `meta` was unreachable by any client, so no list could paginate properly.
- Two screens depended on a `localStorage` key nothing ever wrote.
- `POST /emergencies/:id` took the responder's identity from the request body.

All four were live in code that had passing tests. `pnpm smoke` now covers
public pages, 20 screens, 3 detail screens with live ids, 29 endpoints, and the
permission, incident-scoping, dashboard-scoping, directory and webhook guards.

### Notes for next time

Running `pnpm build` while `pnpm dev` is up corrupts the shared `.next` and the
dev server starts returning 500s. Two agents hit this independently. Build with
dev stopped, or build in a worktree.

`git add -A` while agents are mid-edit sweeps their files into unrelated
commits. Two commits this session carry work their messages do not describe.
Stage explicitly when running agents concurrently.

### Gates

typecheck · lint · **738 tests** · build · bundle budget · **`pnpm smoke` all
checks passed**.

---

## 2026-09-23T17:30Z — Phase 13: The remaining roadmap

Seven subagents under strict file ownership, plus work done directly.

| | Start of session | Now |
|---|---|---|
| App screens | 23 | **30** |
| API routes | 90 | **102 paths, 134 operations** |
| Permissions gating nothing | 8 of 121 | **4 of 122** |
| Tests | 738 | **808** |
| Shared First Load JS | 104.1 kB | **103.8 kB** |

The four still-unenforced permissions are soft-delete variants; this system does
not hard-delete anything.

### Delivered

**The four deferred flows** — email verification, password reset, tenant
invitation, dunning notification. One single-use token collection: SHA-256 only,
expiry inside the lookup filter, consumption as a single conditional update so
two concurrent redemptions cannot both win.

**Reports and exports** — five reports, seventeen tables, RFC-4180 CSV with BOM,
CRLF, quoting and formula neutralisation. Capped at 10,000 rows, with the cap
stated in headers *and* written as the file's last line so a short file is never
mistaken for a complete one.

**Global search** — residents by name, code, phone and NIN blind index; plates,
pass codes, tickets, references, invoices, payments, properties. ⌘K palette.

**Platform console** — cross-tenant estate list, MRR, suspend and restore.

**OpenAPI 3.1**, generated from the route declarations themselves.

**Seven screens** — notifications with preferences, announcements (resident and
admin), exit passes, security passes desk, billing portal, reports, platform.

### Decisions

| Decision | Why |
|---|---|
| Reset and resend pad to a uniform latency floor | The gap between "look up nothing" and "write a token and enqueue an email" is the enumeration oracle, not the response body. |
| Password reset revokes every session | Someone resetting may be doing it because they were compromised. |
| An invitation carries estate, property and category in the token | No request field can redirect the account. Acceptance lands on awaiting-approval: an invitation gets you in the door, not past the administrator. |
| Export is a separate permission from view, checked in the service | Exporting takes data out of the audited system. Checked in the service rather than declared on the route so a **refusal** is audited too — a 403 at the route fires before anything is written. |
| No identity data in any export, at any permission | Someone who needs it uses the audited single-record endpoint, not a spreadsheet that ends up in an inbox. |
| Search mirrors each list endpoint's permission exactly | Search must never be a wider door than the screen it links to. |
| The platform console never touches `BaseRepository` | Its job is to make a cross-tenant query impossible. Going direct, in one named module, keeps an unscoped query visible in review rather than accidental. |
| Emergency and security notifications render as locked, not as toggles | The service ignores an attempt to mute them, and a control that lies about what it does is worse than no control. |
| `nav:check` gates the build | The app once offered 24 links against 6 screens and nothing caught it: the tests exercised services, and a menu entry imports nothing. |

### Fixed

**Archiving an announcement also soft-deleted it**, putting it beyond the
repository's default filter — an administrator who archived a notice could never
find it again, making archive indistinguishable from delete.

**An exit-pass item's `estimatedValue` had no documented unit** — a bare
`number` in a system where all money is integer minor units, so each caller
guessed.

**Notification templates linked into `/portal/...`**, an app that is not this
one. Following an announcement email would have 404'd.

### Two bugs I introduced

Exposing the route declaration on the kernel, I deleted its `return` statement:
every handler became `undefined` at runtime. The first fix then used
`typeof routeHandler` in the return type, creating circular inference that made
handlers non-callable. The kernel's own tests caught both — the second time this
session that a change to `defineRoute` was caught by a test rather than by
review.

### Process notes

`next build` and `next dev` write incompatible output to the same `.next`.
Running one while the other is up leaves every route returning 500 with
`routes-manifest.json` missing. Three agents lost time to this independently
before it was understood. `pnpm clean` and `pnpm dev:clean` now exist and
`docs/DEPLOYMENT.md` says so.

Staging with `git add -A` while agents are mid-write sweeps their files into
unrelated commits. Two commits earlier in this project carry work their messages
do not describe; this phase staged explicitly.

### Gates

typecheck · lint · **808 tests** · build · nav coverage (28/28) · bundle budget ·
**`pnpm smoke` all checks passed**.
