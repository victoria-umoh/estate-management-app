# Security

This system holds national identity numbers, home addresses, records of minors,
movement history and money. A cross-tenant leak or an unaudited privilege
escalation is a business-ending event, not a bug report. This document records
what protects against that, and — more usefully — what has already gone wrong.

---

## 1. Tenant isolation

Isolation is structural, not a rule people remember.

`BaseRepository.scope()` injects `estateId` into every filter, update and
aggregation `$match`, and stamps it on every insert. There is no repository
method that can be called without a `RequestContext`. Compound indexes lead with
`estateId`. Cross-estate reads require the explicitly named `PlatformRepository`,
so they are visible in review rather than implicit.

An ESLint rule forbids `app/**` and `components/**` from importing `schema.ts`
or a repository. Routes call services; services call repositories; only
repositories touch models. This is what keeps scoping unbypassable — a page
cannot construct an unscoped query because it cannot reach the model.

**Cross-tenant access returns 404, never 403.** A 403 confirms the resource
exists, which is enough to enumerate another estate's residents by id.

---

## 2. Identity comes from the session, never the request

Three separate bugs traced to one mistake: letting the client say who it is.

| Bug                                                                | Consequence                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `GET /invoices` gated on `invoice.view`, which residents hold      | Any resident could read every household's billing history                     |
| `POST /emergencies/:id` took `responderMembershipId` from the body | A caller could attribute emergency attendance to someone else                 |
| Two screens read `membershipId` from `localStorage`                | Nothing ever wrote it; the ID card and emergency actions silently did nothing |

`MeService` now answers "who is calling?" once, from the session. Every
resident-facing route goes through it, and none accepts a membership id from the
request. The underlying services keep their own `assertMayActFor` checks — this
is a second line, not a replacement.

**When a permission is held by both a resident and an administrator, it is doing
two jobs and needs splitting.** `invoice.view` (your own) and `invoice.viewAll`
(the estate) is the pattern; `resident.viewNin` was the precedent.

---

## 3. Sensitive data

- NIN, document numbers and bank details are encrypted at rest with
  **AES-256-GCM**, stored as `{ ct, iv, tag, keyVersion }` so keys can rotate.
- A separate **HMAC-SHA256 blind index** allows exact-match lookup and duplicate
  detection without storing or decrypting plaintext. The key is distinct from
  the encryption key, and the field kind is mixed into the HMAC so an index
  value for one field cannot be replayed against another.
- The default serializer returns NIN masked. The full value requires
  `resident.viewNin`, is served by a dedicated endpoint, and **every read writes
  an audit entry**. It never appears in list responses, logs or error messages.
- A NIN _search_ is an identity lookup and carries the same permission and the
  same audit entry. Someone who cannot reveal a NIN must not be able to confirm
  one exists by searching for it.

**A masking function must never invent digits.** An early `maskNin` produced
plausible but fabricated trailing digits for edge-case input. It was replaced
with a stored `ninLast4`, captured at the point the real value was known.

---

## 4. Authentication

- **argon2id** password hashing.
- **Opaque refresh tokens**, stored only as SHA-256 hashes. Rotation on every
  use, with **reuse detection that revokes the entire session family** — a
  replayed token means the token was stolen, and the safe response is to end
  every session descended from it.
- **httpOnly cookie sessions** for the browser, so no token is reachable by
  JavaScript and therefore by an injected script. Bearer tokens remain for
  native clients. Web login requires `client: 'web'` to receive cookies.
- Per-account lockout for targeted attacks, per-IP rate limiting for credential
  stuffing across many accounts.
- TOTP 2FA, session and device registry.

**A timing defence that does no work is not a defence.** The login path compares
against a decoy hash when the account does not exist, so the response time does
not reveal which emails are registered. The first implementation used a
hardcoded fake digest that argon2 rejected at parse — it burned no CPU, so the
timing signal it was meant to hide was fully intact. The decoy is now derived at
startup from real key material.

---

## 5. Authorisation

~120 permissions as `resource.action` strings, in one registry. System roles are
frozen: a chairman who stripped `gate.operate` from the officer role would lock
their own gates, and it would present as a hardware fault rather than a
permission change.

Checks live in services, not routes, so an operation cannot be reached through
an unguarded path. The route kernel's `permissions: []` is a second gate, not
the only one.

**Order the wildcard check before the unknown-permission check.** An early
version reported a privilege-escalation attempt as a typo, because an unknown
permission string was rejected as a mistake before the wildcard branch ran.

---

## 6. Audit

`audit_logs` is append-only, enforced at the ODM layer: `updateOne`,
`updateMany`, `findOneAndUpdate`, `deleteOne` and `deleteMany` all throw. The
same applies to `movements` and `ledger_entries` — the records consulted after a
theft, a dispute or a reconciliation failure. A log that can be quietly amended
is not evidence.

Entries are written **inside the same transaction as the mutation they record**.
Sensitive fields are redacted before storage, and the redaction marker is
rendered as such in the UI so it cannot be mistaken for missing data.

**Redaction by field-name pattern will over-match.** `hasNin` — a boolean —
was being blanked because the name contained `nin`. The field was renamed to
`identityProvided` rather than narrowing the pattern: an over-broad redaction
rule is the safe direction to err.

---

## 7. Money

- Integer minor units (kobo) throughout. Floating-point money accumulates
  rounding error that only surfaces once totals are large enough for someone to
  notice, which is the worst time to find it.
- Double-entry ledger, append-only, with balance enforced at post time. An
  unbalanced, single-sided, zero or fractional transaction is refused.
- **Webhook signatures are HMAC-SHA512 over the raw request body**, compared in
  constant time. JSON is parsed only after the signature validates, so untrusted
  input never reaches `JSON.parse`. The route reads `request.text()` — anything
  that parses and re-serialises first produces different bytes and rejects every
  genuine delivery.
- The webhook **re-verifies the amount against the provider's API**. A valid
  signature proves the message came from the provider, not that the body was not
  replayed from a smaller charge.
- Event ids are claimed under a unique index **before** any work, because
  providers retry and duplicate delivery is routine.
- **Nothing the browser reports after checkout is trusted.** The post-checkout
  redirect is a URL the payer controls.

---

## 8. Gate

The gate is the most physically exposed terminal in the estate: shared, often
unattended, frequently on a cheap tablet. It gets the least privilege that still
works.

- `access_credentials` is keyed by SHA-256 of the scanned token — one indexed
  read, no joins.
- QR payloads are opaque, HMAC-signed and rotatable, so a photograph of an old
  QR fails.
- The security-officer role has `resident.view` but **not** `resident.viewNin`.
  Identity numbers have no operational use at a barrier.

---

## 9. Testing this

`pnpm test` covers services. **`pnpm smoke` is the one that catches what unit
tests cannot**: it signs in as each role and drives every screen with a real
session cookie, then asserts the permission boundaries hold —
`resident → /invoices` must be 403, `resident → /ledger` must be 403, the
resident directory must expose no contact fields, and unsigned and forged
webhooks must both be 401.

Both permission leaks in this codebase were found by driving the API as a real
signed-in user, not by a unit test. A unit test asserts the permission its
author chose; only a real session asserts the permission the role actually has.

---

## 10. Reporting

Security issues should go to the address in `contact.email` on the platform
estate record. Do not open a public issue.
