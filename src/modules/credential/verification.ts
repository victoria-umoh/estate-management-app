import { hashToken, verifyToken } from '@/core/crypto';
import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { CacheNamespace, cacheKey, getCache } from '@/integrations/cache';
import { AccessCredentialModel, type AccessCredentialDoc } from './schema';
import { DENIAL_MESSAGES, type DenialReason, type ScanResult } from './types';

const log = createLogger('gate');

/**
 * Gate verification.
 *
 * The one operation in this system with a hard latency budget, so the ordering
 * here is deliberate:
 *
 *  1. Verify the signature. Pure crypto, no I/O. A forged or corrupted scan is
 *     rejected without touching the database or the cache at all, which means
 *     someone spraying junk at the gate cannot generate load.
 *  2. Check the cache. One key lookup.
 *  3. Fall back to a single indexed query on `tokenHash`. No joins, no
 *     populate, no second read.
 *
 * Cached entries carry a short TTL, because that window is exactly how long a
 * just-revoked pass could still scan as valid. Revocation clears the key
 * directly, so the TTL is the failure mode, not the normal path.
 */

/** What is cached. Kept minimal — this is copied on every scan. */
interface CachedCredential {
  id: string;
  subject: AccessCredentialDoc['subject'];
  subjectId: string;
  estateId: string;
  display: AccessCredentialDoc['display'];
  status: AccessCredentialDoc['status'];
  blacklisted: boolean;
  validFrom: number;
  validUntil: number | null;
}

function keyFor(tokenHash: string): string {
  return cacheKey(CacheNamespace.GATE_CREDENTIAL, tokenHash);
}

function deny(reason: DenialReason, cached = false): ScanResult {
  return { admitted: false, reason, message: DENIAL_MESSAGES[reason], cached };
}

/**
 * Verify a scanned token for a given estate.
 *
 * `estateId` is the gate's own estate. A token naming a different one is
 * refused even if it is otherwise perfectly valid.
 */
export async function verifyScan(token: string, estateId: string): Promise<ScanResult> {
  // --- 1. Signature and expiry, before any I/O -------------------------------
  const verified = verifyToken(token);

  if (!verified.valid) {
    const reason: DenialReason =
      verified.reason === 'expired'
        ? 'expired-token'
        : verified.reason === 'bad-signature'
          ? 'bad-signature'
          : 'malformed';

    return deny(reason);
  }

  const payload = verified.payload!;

  // Checked from the token itself, so a cross-estate scan costs no lookup.
  if (payload.est !== estateId) return deny('wrong-estate');

  const tokenHash = hashToken(token);

  // --- 2. Cache --------------------------------------------------------------
  const cache = await getCache();
  const cached = await cache.get<CachedCredential>(keyFor(tokenHash));

  if (cached) return evaluate(cached, true);

  // --- 3. One indexed read ---------------------------------------------------
  const record = await AccessCredentialModel.findOne(
    { tokenHash },
    {
      // Projected explicitly: the gate never needs issuedBy, revokedReason or
      // the timestamps, and not fetching them keeps the document small.
      subject: 1,
      subjectId: 1,
      estateId: 1,
      display: 1,
      status: 1,
      blacklisted: 1,
      validFrom: 1,
      validUntil: 1,
    },
  )
    .lean<AccessCredentialDoc>()
    .exec();

  if (!record) return deny('unknown-credential');

  const entry: CachedCredential = {
    id: record._id.toHexString(),
    subject: record.subject,
    subjectId: record.subjectId.toHexString(),
    estateId: record.estateId.toHexString(),
    display: record.display,
    status: record.status,
    blacklisted: record.blacklisted,
    validFrom: record.validFrom.getTime(),
    validUntil: record.validUntil?.getTime() ?? null,
  };

  // Only cache admissible states. Caching a blacklist would risk serving it
  // from a stale key after the block is lifted, and caching a denial saves
  // nothing worth the risk.
  if (entry.status === 'active' && !entry.blacklisted) {
    await cache.set(keyFor(tokenHash), entry, config.cache.gateTtlSeconds);
  }

  return evaluate(entry, false);
}

function evaluate(entry: CachedCredential, cached: boolean): ScanResult {
  // Blacklist first. A blacklisted credential is refused whatever its status
  // says, so a stale status cannot admit someone who has been blocked.
  if (entry.blacklisted) return deny('blacklisted', cached);

  if (entry.status === 'revoked') return deny('revoked', cached);
  if (entry.status === 'suspended') return deny('suspended', cached);
  if (entry.status === 'expired') return deny('expired-token', cached);

  const now = Date.now();
  if (entry.validFrom > now) return deny('not-yet-valid', cached);
  if (entry.validUntil !== null && entry.validUntil <= now) return deny('window-closed', cached);

  return {
    admitted: true,
    cached,
    message: 'Admit.',
    credential: {
      credentialId: entry.id,
      subject: entry.subject,
      subjectId: entry.subjectId,
      display: entry.display,
      validUntil: entry.validUntil ? new Date(entry.validUntil) : null,
    },
  };
}

/**
 * Drop a credential from the cache.
 *
 * Called on revocation, suspension and blacklisting. Without this, a blocked
 * pass would keep scanning as valid until its cached entry expired — which is
 * the difference between a revocation taking effect now and taking effect in
 * half a minute.
 */
export async function invalidateCachedCredential(tokenHash: string): Promise<void> {
  (await getCache()).delete(keyFor(tokenHash));
}

/** Clear every cached credential for an estate. Used after a bulk change. */
export async function invalidateEstateCache(): Promise<void> {
  (await getCache()).deleteByPrefix(`${CacheNamespace.GATE_CREDENTIAL}:`);
  log.info('gate credential cache cleared');
}
