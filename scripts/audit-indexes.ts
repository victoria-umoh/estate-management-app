/**
 * Prove the hot queries use indexes, and that every tenant index is scoped.
 *
 * Two different failures this catches.
 *
 * A **collection scan** on a list screen is invisible on seed data and fatal on
 * a real estate — the gate benchmark covers the one query that must never
 * regress, and this covers the rest.
 *
 * An index that does **not lead with `estateId`** is worse than a slow one. The
 * repository always filters on `estateId`, so an index led by anything else is
 * either unused or, if the planner picks it, scanning another tenant's
 * documents before discarding them. The isolation still holds, but the shape is
 * wrong and the cost is paid per tenant.
 *
 *   pnpm audit:indexes
 */
import mongoose from 'mongoose';
import { connectToDatabase } from '@/core/db';
import { shutdownIntegrations } from '@/integrations/shutdown';

interface Check {
  collection: string;
  label: string;
  filter: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
}

const ESTATE = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();

/** One per screen or job that runs often enough to matter. */
const CHECKS: Check[] = [
  {
    collection: 'access_credentials',
    label: 'gate: verify a scanned token',
    filter: { tokenHash: 'x'.repeat(64) },
  },
  {
    collection: 'memberships',
    label: 'residents list, by status',
    filter: { estateId: ESTATE, status: 'active', deletedAt: null },
  },
  {
    collection: 'memberships',
    label: 'approval queue',
    filter: { estateId: ESTATE, status: 'awaiting-approval', deletedAt: null },
  },
  {
    collection: 'properties',
    label: 'properties list',
    filter: { estateId: ESTATE, occupancyStatus: 'owner-occupied', deletedAt: null },
    sort: { street: 1, unitNumber: 1 },
  },
  {
    collection: 'vehicles',
    label: 'vehicle lookup by plate',
    filter: { estateId: ESTATE, plateNormalised: 'ABC123XY' },
  },
  {
    collection: 'visitor_passes',
    label: 'visitors currently inside',
    filter: { estateId: ESTATE, status: 'inside', deletedAt: null },
  },
  {
    collection: 'visitor_passes',
    label: "a host's own passes",
    filter: { estateId: ESTATE, hostMembershipId: OTHER, deletedAt: null },
    sort: { expectedArrival: -1 },
  },
  {
    collection: 'movements',
    label: 'gate activity, recent first',
    filter: { estateId: ESTATE },
    sort: { occurredAt: -1 },
  },
  {
    collection: 'movements',
    label: 'gate activity, entries only',
    filter: { estateId: ESTATE, direction: 'in' },
    sort: { occurredAt: -1 },
  },
  {
    collection: 'movements',
    label: 'denied entries at shift change',
    filter: { estateId: ESTATE, admitted: false },
    sort: { occurredAt: -1 },
  },
  {
    collection: 'incidents',
    label: 'incidents by severity',
    filter: { estateId: ESTATE, status: 'open', deletedAt: null },
    sort: { severityRank: -1, createdAt: -1 },
  },
  {
    collection: 'incidents',
    label: "a resident's own incidents",
    filter: { estateId: ESTATE, reportedByMembershipId: OTHER, deletedAt: null },
  },
  {
    collection: 'service_requests',
    label: 'open tickets by due date',
    filter: { estateId: ESTATE, status: 'open', deletedAt: null },
    sort: { dueAt: 1 },
  },
  {
    collection: 'emergencies',
    label: 'active emergencies',
    filter: { estateId: ESTATE, status: 'triggered', deletedAt: null },
  },
  {
    collection: 'invoices',
    label: "a resident's unpaid invoices",
    filter: { estateId: ESTATE, membershipId: OTHER, status: 'issued', deletedAt: null },
  },
  {
    collection: 'invoices',
    label: 'overdue sweep',
    filter: { estateId: ESTATE, status: 'issued', dueAt: { $lt: new Date() }, deletedAt: null },
  },
  {
    collection: 'payments',
    label: 'payment by provider reference',
    filter: { reference: 'EOS-TEST' },
  },
  {
    collection: 'ledger_entries',
    label: 'trial balance',
    filter: { estateId: ESTATE, account: 'cash' },
  },
  {
    collection: 'notifications',
    label: 'unread notifications',
    filter: { estateId: ESTATE, recipientMembershipId: OTHER, readAt: null },
    sort: { createdAt: -1 },
  },
  {
    collection: 'audit_logs',
    label: 'audit trail by action',
    filter: { estateId: ESTATE, action: 'payment.verified' },
    sort: { createdAt: -1 },
  },
  {
    collection: 'users',
    label: 'identity lookup by blind index',
    filter: { ninIndex: 'a'.repeat(64) },
  },
  {
    collection: 'sessions',
    label: 'refresh token lookup',
    filter: { refreshTokenHash: 'b'.repeat(64) },
  },
  {
    collection: 'exit_passes',
    label: 'exit passes awaiting approval',
    filter: { estateId: ESTATE, status: 'pending', deletedAt: null },
  },
  {
    collection: 'temporary_passes',
    label: 'active temporary passes',
    filter: { estateId: ESTATE, status: 'active', deletedAt: null },
  },
  {
    collection: 'announcements',
    label: 'published announcements',
    filter: { estateId: ESTATE, status: 'published' },
    sort: { pinned: -1, publishedAt: -1 },
  },
];

/**
 * Collections that legitimately index without `estateId`.
 *
 * Identity and credentials are looked up before the tenant is known — a login,
 * a refresh, a scanned token at the gate, a webhook arriving with only a
 * provider reference. Each is a keyed hash or a unique reference, so the lookup
 * is exact rather than a scan across tenants.
 */
const CROSS_TENANT_COLLECTIONS = new Set([
  'users',
  'sessions',
  'estates',
  'roles',
  'access_credentials',
  'payments',
  'account_tokens',
]);

/**
 * Below this, MongoDB scans regardless and is right to.
 *
 * Reporting a scan of a twelve-document collection as a failure trains people
 * to skim past the output, which is how a real one gets missed.
 */
const SCAN_IS_FINE_BELOW = 50;

/**
 * Indexes that deliberately do not lead with `estateId`, and why.
 *
 * Each is a lookup that happens *before* the tenant is known, or a job that
 * sweeps every estate in one pass. Listing them by name rather than exempting
 * whole collections means a new unscoped index still has to be justified here.
 */
const CROSS_ESTATE_BY_DESIGN = new Map<string, string>([
  ['memberships.userId_1_status_1', 'login resolves a user to their memberships before any estate is chosen'],
  ['visitor_passes.status_1_expectedDeparture_1_overstayNotifiedAt_1', 'the overstay sweep runs across every estate in one pass'],
  ['service_requests.status_1_dueAt_1_escalatedAt_1', 'the SLA sweep runs across every estate in one pass'],
  ['audit_logs.actorId_1_createdAt_-1', 'answers "what did this person do", which spans the estates they belong to'],
  ['vehicles.plateNormalised_1_estateId_1', 'the gate looks a plate up before it knows which estate to scope to'],
  ['webhook_events.provider_1_eventId_1', 'a webhook arrives carrying a provider reference and nothing else'],
  ['accounttokens.purpose_1_userId_1_consumedAt_1', 'an emailed token is redeemed before any session exists'],
  ['accounttokens.purpose_1_emailIndex_1_consumedAt_1', 'an emailed token is redeemed before any session exists'],
]);

let problems = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) problems++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(42)} ${detail}`);
}

async function auditQueries(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');

  console.log('\nQuery plans\n');

  for (const check of CHECKS) {
    const collections = await db.listCollections({ name: check.collection }).toArray();
    if (collections.length === 0) {
      report(true, `${check.collection}: ${check.label}`, 'collection not present');
      continue;
    }

    const documents = await db.collection(check.collection).estimatedDocumentCount();
    if (documents < SCAN_IS_FINE_BELOW) {
      report(true, `${check.collection}: ${check.label}`, `${documents} docs — too small to plan`);
      continue;
    }

    const cursor = db.collection(check.collection).find(check.filter);
    if (check.sort) cursor.sort(check.sort);

    const plan = (await cursor.explain('queryPlanner')) as {
      queryPlanner?: { winningPlan?: Record<string, unknown> };
    };

    const winning = JSON.stringify(plan.queryPlanner?.winningPlan ?? {});
    const scansCollection = winning.includes('"COLLSCAN"');
    // A sort the index cannot satisfy is done in memory, and fails outright
    // past 32MB — which is a production-only failure on a large estate.
    const sortsInMemory = winning.includes('"SORT"');

    const detail = [
      scansCollection ? 'COLLSCAN' : 'IXSCAN',
      sortsInMemory ? '+ in-memory SORT' : '',
    ]
      .filter(Boolean)
      .join(' ');

    report(!scansCollection && !sortsInMemory, `${check.collection}: ${check.label}`, detail);
  }
}

async function auditScoping(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');

  console.log('\nTenant indexes lead with estateId\n');

  for (const info of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (CROSS_TENANT_COLLECTIONS.has(info.name)) continue;

    const indexes = await db.collection(info.name).indexes();

    for (const index of indexes) {
      if (index.name === '_id_') continue;

      const [first] = Object.keys(index.key);
      // A single-field unique index on a globally-unique value is fine; anything
      // compound should start at the tenant.
      const compound = Object.keys(index.key).length > 1;

      if (compound && first !== 'estateId') {
        const key = `${info.name}.${index.name}`;
        const reason = CROSS_ESTATE_BY_DESIGN.get(key);

        if (reason) report(true, key, `cross-estate: ${reason}`);
        else report(false, key, `leads with "${first}" and is not listed as cross-estate by design`);
      }
    }
  }

  if (problems === 0) {
    console.log('\n  Every other compound index leads with estateId.');
  }
}

async function main(): Promise<void> {
  await connectToDatabase();

  try {
    await auditQueries();
    await auditScoping();

    console.log(
      problems === 0
        ? '\nIndex audit passed.\n'
        : `\n${problems} problem(s). A COLLSCAN or an in-memory sort is invisible on seed data and fatal on a real estate.\n`,
    );
  } finally {
    await shutdownIntegrations();
    await mongoose.disconnect();
  }

  process.exit(problems === 0 ? 0 : 1);
}

await main();
