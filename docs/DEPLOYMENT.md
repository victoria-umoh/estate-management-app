# Deployment

This application runs in two shapes: **serverless** (Vercel) and **self-hosted**
(Docker, or any Node host). Every integration sits behind an interface with an
adapter for each, so the choice is configuration rather than a fork.

---

## 1. What it needs

|                       | Requirement         | Why                                                                                                                                                                                                                                          |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                  | 22+                 | The code uses `process.loadEnvFile` and modern ESM.                                                                                                                                                                                          |
| MongoDB               | **7+, replica set** | Not optional. The app uses multi-document transactions — an invoice and its ledger entries commit together. A standalone `mongod` rejects them. Atlas gives you a replica set by default; a local one needs `--replSet` and `rs.initiate()`. |
| Redis                 | 7+ (optional)       | Rate limits, the gate credential cache, and BullMQ. Without it, set `CACHE_DRIVER=memory` — but see the warning below.                                                                                                                       |
| S3-compatible storage | optional            | Photos and incident media. Works against S3, Cloudflare R2 and MinIO.                                                                                                                                                                        |

**`CACHE_DRIVER=memory` is for a single process only.** Rate limits and
idempotency keys held in one process's memory are not shared, so two instances
behind a load balancer each enforce their own limit and neither sees the other's
idempotency records. The config schema rejects `memory` in production for this
reason.

---

## 2. Configuration

Every variable is documented in `.env.example`, grouped by concern, with what it
does and what happens if it is missing. Copy it and fill it in.

Config is **Zod-validated and lazy** — it validates on first access rather than
at import, so a build does not need production secrets. `assertConfigValid()`
runs at boot, which is where a missing variable should fail: loudly, at start-up,
not on the first request that happens to need it.

### The ones that must be set, and must be right

```
MONGODB_URI              # replica set; see §1
JWT_SECRET               # 32+ bytes of randomness
ENCRYPTION_KEY           # 32 bytes, base64 — encrypts NIN and bank details
ENCRYPTION_BLIND_INDEX_KEY   # 32 bytes, base64 — SEPARATE from the above
SESSION_COOKIE_SECRET
CRON_SECRET              # authenticates the scheduled-job HTTP routes
```

**The two encryption keys must differ.** The blind index is an HMAC over the
same plaintext the encryption key protects; sharing a key between them
undermines both.

**Losing `ENCRYPTION_KEY` means losing every encrypted field.** There is no
recovery path — that is the point of encryption at rest. Back it up somewhere
that is not this repository and not the same vault as the database credentials.

**Rotating it** is supported: fields store `{ ct, iv, tag, keyVersion }`. Add the
new key, re-encrypt in the background, then retire the old one. Do not remove a
key version while any document still references it.

---

## 3. Local development

```bash
docker compose up -d      # Mongo replica set, Redis, MinIO
pnpm install
cp .env.example .env      # then fill it in
pnpm db:indexes           # REQUIRED — see below
pnpm seed:demo            # a demo estate with accounts per role
pnpm dev
```

**`pnpm db:indexes` is not optional on a fresh database.** Mongoose runs with
`autoIndex` off, so a new database has no unique constraints until they are
built — and seeding into one will happily create two accounts with the same
email, which is exactly what the identity design forbids. Run it before anything
writes.

Re-running the demo seeder needs `--reset`: the demo accounts use fixed
addresses which are unique platform-wide, so a second run collides on the email
index. That is the index working; `--reset` clears the previous demo estate
first.

`PORT` in `.env` sets the dev port.

**Do not run `pnpm build` while `pnpm dev` is running.** They write incompatible
output to the same `.next`, and afterwards every route returns 500 with
`routes-manifest.json` missing. `pnpm dev:clean` clears the directory and
restarts; `pnpm clean` just clears it. This cost three separate debugging
detours before it was understood, so it is worth knowing up front.

---

## 4. Deploying to Vercel

1. Set every variable from `.env.example` in the project settings.
2. `CACHE_DRIVER=upstash` with `UPSTASH_REDIS_REST_URL` and `..._TOKEN` — the
   ioredis adapter holds a TCP connection, which does not suit a serverless
   invocation.
3. `QUEUE_DRIVER=inline` and drive the jobs by Vercel Cron against the signed
   routes under `/api/cron/*`, authenticated with `CRON_SECRET`.
4. `STORAGE_DRIVER=s3`.
5. Run `pnpm db:indexes` once against the production database, from a machine
   that can reach it. It is not run at boot — building indexes on a large
   collection can take minutes, and a cold start is the wrong place for it.

---

## 5. Deploying self-hosted

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:indexes
pnpm start
```

With `CACHE_DRIVER=ioredis`, `QUEUE_DRIVER=bullmq` and a worker process
alongside the web process. Run the jobs on a scheduler:

| Job                 | Suggested cadence | What it does                                                                                                                                                      |
| ------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm job:overstay` | every 5–15 min    | Flags visitors still inside past their departure.                                                                                                                 |
| `pnpm job:billing`  | daily             | Raises invoices for fees falling due. Safe to run daily — the fee period is part of the invoice's unique index, so a repeat collides rather than double-charging. |
| `pnpm job:overdue`  | daily             | Flags arrears.                                                                                                                                                    |
| `pnpm job:dunning`  | daily             | Moves lapsed estates through grace to suspension.                                                                                                                 |
| `pnpm job:sla`      | hourly            | Escalates service requests past their SLA.                                                                                                                        |

### Running it under PM2

`ecosystem.config.cjs` runs the web server with automatic restart (exponential
back-off, recycled above 1 GB), the notification worker (`pnpm worker`, which
sends queued email and SMS when `QUEUE_DRIVER=bullmq` and exits cleanly
otherwise), and each job above on its own cron schedule.

```bash
npm install -g pm2
pnpm install --frozen-lockfile && pnpm build && pnpm db:indexes
mkdir -p logs
pm2 start ecosystem.config.cjs --env production
pm2 save                 # remember this process list
pm2 startup              # prints a sudo command — run it, so PM2 starts on boot
```

After each deploy: `git pull && pnpm install --frozen-lockfile && pnpm build &&
pm2 reload ecosystem.config.cjs --env production`. `--env production` sets
`NODE_ENV=production`, which switches on the production config checks: an HTTPS
`APP_URL` and no `memory`, `inline`, `local` or `console` drivers.

Behind a reverse proxy, forward `X-Forwarded-For` — rate limiting and the audit
trail both record the client IP, and without it every request appears to come
from the proxy.

---

## 6. Before you go live

```bash
pnpm verify          # everything, in fail-fast order
pnpm verify --fast   # everything except the end-to-end suite
```

That runs typecheck, lint, the unit suite, the build with its navigation and
bundle-budget checks, the index audit, a reseed, the OpenAPI freshness check,
`pnpm smoke` and the end-to-end suite — stopping and restarting the dev server
at the right points, because `build` and `dev` share `.next` and corrupt each
other. The individual commands still work if you want one of them:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm smoke          # against a running instance with seeded data
```

`pnpm smoke` is the one that matters. It signs in as each role and drives every
screen with a real session cookie, then asserts the permission boundaries — that
a resident is refused the estate's invoices, ledger, fees and audit log, that the
resident directory carries no contact details, and that unsigned and forged
webhooks are both rejected. Point it at a staging instance with `BASE_URL`.

`pnpm build` also fails if a navigation link has no page behind it, or if a
bundle exceeds its budget.

**End-to-end**, covering the six acceptance workflows plus appearance at 320px,
tablet and desktop in both themes:

```bash
pnpm clean && pnpm dev          # in one terminal
E2E_BASE_URL=http://localhost:3800 pnpm test:e2e
```

The `clean` matters. This suite passes 38 of 38 on a freshly started dev server
and degrades on one that has been up a while — `next dev` slows badly under
sustained recompilation, eventually taking tens of seconds to serve a route it
has already built, and the specs then time out one by one. Serialising the suite
was tried as a fix and is not one: it tripled the runtime and failed the same
specs. If a run is flaky, restart the server before looking for a cause in the
tests.

### Checklist

- [ ] `ENCRYPTION_KEY` and `ENCRYPTION_BLIND_INDEX_KEY` are different, and both
      are backed up outside this repository
- [ ] `MONGODB_URI` points at a replica set
- [ ] `CACHE_DRIVER` is not `memory`
- [ ] `pnpm db:indexes` has run against this database
- [ ] `CRON_SECRET` is set and the scheduler sends it
- [ ] `NODE_ENV=production` (the demo seeder refuses to run against it)
- [ ] Paystack webhook points at `/api/webhooks/paystack` and
      `PAYSTACK_WEBHOOK_SECRET` matches the dashboard
- [ ] TLS terminated; session cookies are `Secure` and will not be sent over
      plain HTTP

---

## 7. Operating it

**Backups.** The append-only collections — `audit_logs`, `movements`,
`ledger_entries` — are the ones consulted after a theft, a dispute or a
reconciliation failure. They are also the ones that grow. Back them up on the
same schedule as everything else, and do not prune them without a retention
decision written down.

**Observability.** Sentry and New Relic are wired and DSN-gated: with no DSN they
load nothing, so they cost no bundle weight when unused. Logs are structured
(pino) with a correlation id on every request, which is also returned in the
error envelope as `requestId` — when a user quotes one, it will be in the logs.

**Gate latency.** `pnpm bench:gate` asserts the p95 verification time and that
the query uses an index scan. The gate runs on cheap tablets on poor
connections; if that benchmark regresses, something has leaked into the shared
bundle or an index has been dropped.

**A failed payment webhook returns 500 on purpose**, so Paystack retries. The
alternative is acknowledging a payment that was not recorded.
