import { Types } from 'mongoose';
import { blindIndex, normalizeForIndex } from '@/core/crypto';
import { PERMISSIONS, can } from '@/core/rbac';
import { assertTenantContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { InvoiceModel, PaymentModel } from '@/modules/finance';
import { IncidentModel } from '@/modules/incident/schema';
import { MembershipModel, type MembershipDoc } from '@/modules/membership/schema';
import { PropertyModel } from '@/modules/property/schema';
import { ServiceRequestModel } from '@/modules/service-request/schema';
import { UserModel } from '@/modules/user/schema';
import { VehicleModel } from '@/modules/vehicle/schema';
import { VisitorPassModel } from '@/modules/visitor/schema';

/**
 * One box that finds anything in the estate.
 *
 * Three rules shape everything below.
 *
 * 1. PERMISSION IS CHECKED PER RESULT TYPE, not once for the endpoint. Search
 *    is the feature that quietly joins every collection together, so a single
 *    "can you search?" gate would hand a resident the estate's invoice ledger
 *    the moment they typed an invoice number. Each block is computed only if
 *    the caller could have reached the same record through its own list
 *    endpoint — the same shape `dashboardService.load` uses, for the same
 *    reason. The permissions here deliberately mirror the GET routes under
 *    `/api/v1`, so search is never a wider door than the screens it links to.
 *
 * 2. EVERY QUERY IS ESTATE-SCOPED. Each filter carries `estateId` from the
 *    request context. Cross-tenant leakage through search would be silent and
 *    total, so there is no code path here that builds a filter without it.
 *
 * 3. ENCRYPTED IDENTIFIERS ARE MATCHED BY BLIND INDEX, NEVER DECRYPTED. NIN and
 *    phone are stored as AES-GCM ciphertext with an HMAC index alongside, so
 *    the query is hashed under the same key and compared to the index. That
 *    also means these are exact-match only: there is no "starts with" over a
 *    keyed hash, and there must not be — a prefix search over identity numbers
 *    is a decryption oracle built by hand.
 *
 * No decrypted value is ever returned. A NIN search answers with the resident
 * it matched and nothing else.
 */

export type SearchResultType =
  | 'resident'
  | 'property'
  | 'vehicle'
  | 'visitor-pass'
  | 'service-request'
  | 'incident'
  | 'invoice'
  | 'payment';

export interface SearchResult {
  type: SearchResultType;
  /** Identifier of the matched record, for the link target. */
  id: string;
  title: string;
  subtitle: string | null;
  /** Screen this result navigates to. */
  href: string;
  /** Short status word, rendered as a chip. */
  status?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface SearchInput {
  q: string;
  /** Cap per result type. Kept small: this runs on every keystroke. */
  limit?: number;
}

/**
 * Below this a query matches most of the estate and the work is wasted. Two
 * characters is also what makes an anchored prefix index useful.
 */
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 64;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;

/** Nigerian NIN length. Only an exact-length query is treated as one. */
const NIN_DIGITS = 11;

/**
 * Order results are presented in. People, then places, then paperwork —
 * roughly the order of urgency at a gate or a front desk.
 */
const TYPE_ORDER: SearchResultType[] = [
  'resident',
  'property',
  'vehicle',
  'visitor-pass',
  'incident',
  'service-request',
  'invoice',
  'payment',
];

/**
 * A user-supplied string must never become a pattern, and the pattern must stay
 * anchored so Mongo can use the index rather than scanning the collection.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function startsWith(value: string): { $regex: string; $options: string } {
  return { $regex: `^${escapeRegex(value)}`, $options: 'i' };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** Plate matching uses the same normalisation the vehicle module stores. */
function normalisePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Does this look like someone typing a phone number?
 *
 * Deliberately conservative. A false positive costs one extra indexed lookup;
 * being too eager would turn every numeric query into an identity probe.
 */
function looksLikePhone(value: string): boolean {
  if (!/^[+\d][\d\s()+-]*$/.test(value)) return false;
  return digitsOnly(value).length >= 10;
}

function looksLikeNin(value: string): boolean {
  if (!/^[\d\s-]+$/.test(value)) return false;
  return digitsOnly(value).length === NIN_DIGITS;
}

export class SearchService {
  async search(context: RequestContext, input: SearchInput): Promise<SearchResponse> {
    // Fails closed for an anonymous context, which carries no estate at all.
    assertTenantContext(context);

    const q = input.q.trim();
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    if (q.length < MIN_QUERY_LENGTH || q.length > MAX_QUERY_LENGTH) {
      return { query: q, results: [] };
    }

    const estateId = new Types.ObjectId(context.estateId);

    // Every permitted block runs concurrently: eight small indexed queries in
    // parallel is the difference between a palette that feels instant and one
    // that lags a keystroke behind.
    const tasks: Array<Promise<SearchResult[]>> = [];

    // --- People -------------------------------------------------------------
    // `resident.view` is the directory permission. Residents do not hold it,
    // which is what keeps one household from enumerating another.
    if (can(context, PERMISSIONS.RESIDENT_VIEW)) {
      tasks.push(this.searchResidents(estateId, q, limit));
    }

    // A NIN lookup is an identity lookup. It needs `resident.viewNin` — the
    // same permission that reveals one — because otherwise anybody with the
    // directory could confirm that a given NIN belongs to this estate, which is
    // most of the value of holding the number. Audited on every attempt.
    if (looksLikeNin(q) && can(context, PERMISSIONS.RESIDENT_VIEW_NIN)) {
      tasks.push(this.searchByNin(context, estateId, q));
    }

    // --- Places -------------------------------------------------------------
    if (can(context, PERMISSIONS.PROPERTY_VIEW)) {
      tasks.push(this.searchProperties(estateId, q, limit));
    }

    // --- Things at the gate --------------------------------------------------
    if (can(context, PERMISSIONS.VEHICLE_VIEW)) {
      tasks.push(this.searchVehicles(estateId, q, limit));
    }

    if (can(context, PERMISSIONS.VISITOR_VIEW)) {
      tasks.push(this.searchVisitorPasses(estateId, q, limit));
    }

    // --- Paperwork ----------------------------------------------------------
    if (can(context, PERMISSIONS.INCIDENT_VIEW)) {
      tasks.push(this.searchIncidents(estateId, q, limit));
    }

    if (can(context, PERMISSIONS.SERVICE_REQUEST_VIEW)) {
      tasks.push(this.searchServiceRequests(estateId, q, limit));
    }

    // --- Money --------------------------------------------------------------
    // `invoice.viewAll`, not `invoice.view`. Every resident holds the latter to
    // see their own dues; gating estate-wide search on it would let any
    // resident pull up any other household's bill by guessing a number, which
    // is exactly the leak this split exists to prevent.
    if (can(context, PERMISSIONS.INVOICE_VIEW_ALL)) {
      tasks.push(this.searchInvoices(estateId, q, limit));
    }

    // `ledger.view` rather than `payment.view`, for the same reason: residents
    // hold `payment.view` so they can see their own receipts, and there is no
    // estate-wide payments list endpoint for search to mirror. `ledger.view` is
    // the permission that already means "see the estate's money", and it is
    // what the finance screen these results link to requires.
    if (can(context, PERMISSIONS.LEDGER_VIEW)) {
      tasks.push(this.searchPayments(estateId, q, limit));
    }

    const settled = await Promise.all(tasks);

    // A NIN hit and a name hit can be the same person; keep the first.
    const seen = new Set<string>();
    const results = settled
      .flat()
      .filter((result) => {
        const key = `${result.type}:${result.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));

    return { query: q, results };
  }

  // ---------------------------------------------------------------------------
  // Residents
  // ---------------------------------------------------------------------------

  /**
   * Name, resident code, or phone number.
   *
   * Starts from `users` only to resolve a set of ids, then constrains the
   * tenant-scoped `memberships` query with them — the same order
   * `residentService.list` uses. Searching the global user collection and
   * filtering afterwards is one forgotten clause away from a cross-estate leak.
   */
  private async searchResidents(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const clauses: Array<Record<string, unknown>> = [];

    // Each whitespace-separated token may be a first or a last name, so
    // "Ada Okonkwo" matches whichever way round it was typed.
    const nameClauses = q
      .split(/\s+/)
      .filter((token) => token.length >= MIN_QUERY_LENGTH)
      .flatMap((token) => [{ firstName: startsWith(token) }, { lastName: startsWith(token) }]);

    if (nameClauses.length > 0) {
      clauses.push(...nameClauses);
    }

    // Phone is encrypted; its blind index is the only way to match it, and
    // only exactly.
    if (looksLikePhone(q) && normalizeForIndex(q, 'phone').length > 0) {
      clauses.push({ phoneIndex: blindIndex(q, 'phone') });
    }

    const userIds =
      clauses.length > 0
        ? (
            await UserModel.find({ $or: clauses, deletedAt: null }, { _id: 1 }).limit(200).lean()
          ).map((user) => user._id)
        : [];

    const membershipClauses: Array<Record<string, unknown>> = [{ residentCode: startsWith(q) }];
    if (userIds.length > 0) membershipClauses.push({ userId: { $in: userIds } });

    const memberships = await MembershipModel.find({
      estateId,
      deletedAt: null,
      $or: membershipClauses,
    })
      .limit(limit)
      .lean<MembershipDoc[]>();

    return this.toResidentResults(estateId, memberships);
  }

  /**
   * Exact NIN lookup, by blind index.
   *
   * The plaintext never leaves the request: it is hashed, compared, and
   * discarded. The result is the resident and nothing else — no NIN, no masked
   * NIN, no verification state. Confirming "this number belongs to this person"
   * is already the sensitive part, which is why the attempt is recorded whether
   * it matched or not.
   */
  private async searchByNin(
    context: RequestContext,
    estateId: Types.ObjectId,
    q: string,
  ): Promise<SearchResult[]> {
    const user = await UserModel.findOne(
      { ninIndex: blindIndex(q, 'nin'), deletedAt: null },
      { _id: 1 },
    ).lean();

    const membership = user
      ? await MembershipModel.findOne({
          estateId,
          userId: user._id,
          deletedAt: null,
        }).lean<MembershipDoc>()
      : null;

    await auditService.record(context, {
      action: 'search.nin_lookup',
      resource: 'resident',
      resourceId: membership?._id.toHexString() ?? null,
      outcome: membership ? 'success' : 'failure',
      ...(membership ? {} : { reason: 'no match' }),
      // The searched value is never written to the trail — only that someone
      // ran an identity lookup, and against whom it resolved.
      metadata: membership ? { subjectUserId: user!._id.toHexString() } : {},
    });

    return membership ? this.toResidentResults(estateId, [membership]) : [];
  }

  /** Batch the name and unit lookups so a page of hits is three queries, not 3n. */
  private async toResidentResults(
    estateId: Types.ObjectId,
    memberships: MembershipDoc[],
  ): Promise<SearchResult[]> {
    if (memberships.length === 0) return [];

    const propertyIds = memberships
      .map((membership) => membership.propertyId)
      .filter((id): id is Types.ObjectId => Boolean(id));

    const [users, properties] = await Promise.all([
      UserModel.find(
        { _id: { $in: memberships.map((membership) => membership.userId) } },
        { firstName: 1, lastName: 1 },
      ).lean(),
      propertyIds.length > 0
        ? PropertyModel.find(
            { estateId, _id: { $in: propertyIds }, deletedAt: null },
            { unitNumber: 1 },
          ).lean()
        : Promise.resolve([]),
    ]);

    const userById = new Map(users.map((user) => [user._id.toHexString(), user]));
    const unitById = new Map(
      properties.map((property) => [property._id.toHexString(), property.unitNumber]),
    );

    return memberships
      .map((membership): SearchResult | null => {
        const user = userById.get(membership.userId.toHexString());
        if (!user) return null;

        const unit = membership.propertyId
          ? unitById.get(membership.propertyId.toHexString())
          : undefined;

        return {
          type: 'resident' as const,
          id: membership._id.toHexString(),
          title: `${user.firstName} ${user.lastName}`,
          subtitle:
            [membership.residentCode, unit ? `Unit ${unit}` : null].filter(Boolean).join(' · ') ||
            null,
          href: `/admin/residents/${membership._id.toHexString()}`,
          status: membership.status,
        };
      })
      .filter((result): result is SearchResult => result !== null);
  }

  // ---------------------------------------------------------------------------
  // Everything else
  // ---------------------------------------------------------------------------

  private async searchProperties(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const properties = await PropertyModel.find(
      { estateId, deletedAt: null, unitNumber: startsWith(q) },
      { unitNumber: 1, street: 1, block: 1, occupancyStatus: 1 },
    )
      .limit(limit)
      .lean();

    return properties.map((property) => ({
      type: 'property',
      id: property._id.toHexString(),
      title: `Unit ${property.unitNumber}`,
      subtitle: [property.block, property.street].filter(Boolean).join(', ') || null,
      href: `/admin/properties/${property._id.toHexString()}`,
      status: property.occupancyStatus,
    }));
  }

  private async searchVehicles(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const normalised = normalisePlate(q);
    if (normalised.length < MIN_QUERY_LENGTH) return [];

    const vehicles = await VehicleModel.find(
      { estateId, deletedAt: null, plateNormalised: startsWith(normalised) },
      { plateNumber: 1, make: 1, model: 1, colour: 1, status: 1 },
    )
      .limit(limit)
      .lean();

    return vehicles.map((vehicle) => ({
      type: 'vehicle',
      id: vehicle._id.toHexString(),
      title: vehicle.plateNumber,
      subtitle: `${vehicle.colour} ${vehicle.make} ${vehicle.model}`,
      href: '/admin/vehicles',
      status: vehicle.status,
    }));
  }

  private async searchVisitorPasses(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const passes = await VisitorPassModel.find(
      { estateId, deletedAt: null, code: startsWith(q.toUpperCase()) },
      { code: 1, visitorName: 1, status: 1, expectedArrival: 1 },
    )
      .limit(limit)
      .lean();

    return passes.map((pass) => ({
      type: 'visitor-pass',
      id: pass._id.toHexString(),
      title: pass.code,
      subtitle: pass.visitorName,
      href: '/security',
      status: pass.status,
    }));
  }

  private async searchIncidents(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const incidents = await IncidentModel.find(
      { estateId, deletedAt: null, reference: startsWith(q.toUpperCase()) },
      { reference: 1, title: 1, status: 1, severity: 1 },
    )
      .limit(limit)
      .lean();

    return incidents.map((incident) => ({
      type: 'incident',
      id: incident._id.toHexString(),
      title: incident.reference,
      subtitle: incident.title,
      href: `/admin/incidents/${incident._id.toHexString()}`,
      status: incident.status,
    }));
  }

  private async searchServiceRequests(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const requests = await ServiceRequestModel.find(
      { estateId, deletedAt: null, ticketNumber: startsWith(q.toUpperCase()) },
      { ticketNumber: 1, subject: 1, status: 1 },
    )
      .limit(limit)
      .lean();

    return requests.map((request) => ({
      type: 'service-request',
      id: request._id.toHexString(),
      title: request.ticketNumber,
      subtitle: request.subject,
      href: '/admin/requests',
      status: request.status,
    }));
  }

  private async searchInvoices(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const invoices = await InvoiceModel.find(
      { estateId, deletedAt: null, number: startsWith(q.toUpperCase()) },
      { number: 1, total: 1, amountPaid: 1, currency: 1, status: 1 },
    )
      .limit(limit)
      .lean();

    return invoices.map((invoice) => ({
      type: 'invoice',
      id: invoice._id.toHexString(),
      title: invoice.number,
      subtitle: `${invoice.currency} ${(invoice.total / 100).toFixed(2)}`,
      href: '/admin/finance',
      status: invoice.status,
    }));
  }

  private async searchPayments(
    estateId: Types.ObjectId,
    q: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const payments = await PaymentModel.find(
      { estateId, deletedAt: null, reference: startsWith(q) },
      { reference: 1, amount: 1, currency: 1, status: 1, provider: 1 },
    )
      .limit(limit)
      .lean();

    return payments.map((payment) => ({
      type: 'payment',
      id: payment._id.toHexString(),
      title: payment.reference,
      subtitle: `${payment.currency} ${(payment.amount / 100).toFixed(2)} · ${payment.provider}`,
      href: '/admin/finance',
      status: payment.status,
    }));
  }
}

export const searchService = new SearchService();
