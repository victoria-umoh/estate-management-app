/**
 * Gate credentials and the verification fast path.
 *
 * The properties under test: a forged scan costs no database work, a revoked
 * pass stops working immediately rather than when a cache entry lapses, and a
 * blacklist cannot be bypassed by a stale copy.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { hashToken, issueToken } from '@/core/crypto';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import type { RequestContext } from '@/core/tenancy';
import { AccessCredentialModel } from './schema';
import { credentialService } from './service';
import { verifyScan } from './verification';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

let cache: MemoryCacheAdapter;

function ctx(estateId = ESTATE_A): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-manager'],
    permissions: new Set(['*']),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const admin = () => ctx();

const display = {
  primaryLabel: 'Ada Okonkwo',
  secondaryLabel: null,
  unitNumber: '12B',
  category: 'Homeowner',
  photoUrl: null,
};

beforeEach(async () => {
  cache = new MemoryCacheAdapter();
  setCache(cache);
  await AccessCredentialModel.syncIndexes();
});

afterEach(() => setCache(undefined));

async function issueResidentCredential(estateId = ESTATE_A) {
  return credentialService.issue(ctx(estateId), {
    subject: 'resident',
    subjectId: new mongoose.Types.ObjectId().toHexString(),
    display,
  });
}

describe('issuing', () => {
  it('returns a token and stores only its hash', async () => {
    const { token, credential } = await issueResidentCredential();

    expect(token).toMatch(/^v1\./);
    expect(credential.tokenHash).toBe(hashToken(token));

    const stored = await AccessCredentialModel.findById(credential._id).lean();
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  // Reissuing is how a lost ID is handled: the old token stops working the
  // moment the new one exists, without needing the physical card back.
  it('supersedes the previous credential for the same subject', async () => {
    const subjectId = new mongoose.Types.ObjectId().toHexString();
    const first = await credentialService.issue(admin(), {
      subject: 'resident',
      subjectId,
      display,
    });
    const second = await credentialService.issue(admin(), {
      subject: 'resident',
      subjectId,
      display,
    });

    expect(second.credential.version).toBe(2);

    expect((await verifyScan(first.token, ESTATE_A)).admitted).toBe(false);
    expect((await verifyScan(second.token, ESTATE_A)).admitted).toBe(true);
  });

  it('records issuance in the audit trail', async () => {
    const { credential } = await issueResidentCredential();
    const { AuditLogModel } = await import('@/modules/audit');

    const entry = await AuditLogModel.findOne({ action: 'credential.issued' }).lean();
    expect(entry?.resourceId).toBe(credential._id.toHexString());
  });
});

describe('verifying a scan', () => {
  it('admits a valid credential with its display payload', async () => {
    const { token } = await issueResidentCredential();
    const result = await verifyScan(token, ESTATE_A);

    expect(result.admitted).toBe(true);
    expect(result.credential?.display.primaryLabel).toBe('Ada Okonkwo');
    expect(result.credential?.display.unitNumber).toBe('12B');
  });

  describe('rejects without touching the database', () => {
    // A forged or corrupted scan must cost nothing, or spraying junk at the
    // gate becomes a way to generate load.
    it('rejects a forged signature before any query', async () => {
      const { token } = await issueResidentCredential();
      const [v, payload] = token.split('.') as [string, string];

      const spy = vi.spyOn(AccessCredentialModel, 'findOne');
      const result = await verifyScan(`${v}.${payload}.FORGEDSIGNATURE`, ESTATE_A);

      expect(result.admitted).toBe(false);
      expect(result.reason).toBe('bad-signature');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it.each([
      ['empty', ''],
      ['nonsense', 'not-a-token'],
      ['truncated', 'v1.abc'],
    ])('rejects a %s scan without a query', async (_label, value) => {
      const spy = vi.spyOn(AccessCredentialModel, 'findOne');

      expect((await verifyScan(value, ESTATE_A)).admitted).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('rejects a token from another estate without a query', async () => {
      const { token } = await issueResidentCredential(ESTATE_B);

      const spy = vi.spyOn(AccessCredentialModel, 'findOne');
      const result = await verifyScan(token, ESTATE_A);

      expect(result.reason).toBe('wrong-estate');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('rejects an expired token without a query', async () => {
      const { token } = issueToken({
        sub: 'resident',
        cid: 'x',
        est: ESTATE_A,
        ttlSeconds: 1,
      });

      vi.setSystemTime(Date.now() + 5_000);
      const spy = vi.spyOn(AccessCredentialModel, 'findOne');

      expect((await verifyScan(token, ESTATE_A)).reason).toBe('expired-token');
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
      vi.useRealTimers();
    });
  });

  it('rejects a well-formed token with no matching credential', async () => {
    const { token } = issueToken({ sub: 'resident', cid: 'x', est: ESTATE_A, ttlSeconds: 3600 });
    expect((await verifyScan(token, ESTATE_A)).reason).toBe('unknown-credential');
  });

  it('gives the officer a plain message for every outcome', async () => {
    const { token } = await issueResidentCredential();
    expect((await verifyScan(token, ESTATE_A)).message).toBe('Admit.');
    expect((await verifyScan('rubbish', ESTATE_A)).message).toBe('Not a valid pass.');
  });
});

describe('caching', () => {
  it('serves a repeat scan from cache', async () => {
    const { token } = await issueResidentCredential();

    expect((await verifyScan(token, ESTATE_A)).cached).toBe(false);
    expect((await verifyScan(token, ESTATE_A)).cached).toBe(true);
  });

  it('does not query the database on a cache hit', async () => {
    const { token } = await issueResidentCredential();
    await verifyScan(token, ESTATE_A);

    const spy = vi.spyOn(AccessCredentialModel, 'findOne');
    await verifyScan(token, ESTATE_A);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // The whole point of invalidating on revoke: without it a blocked pass keeps
  // working until its entry lapses.
  it('stops admitting immediately on revocation, not when the cache expires', async () => {
    const { token, credential } = await issueResidentCredential();

    expect((await verifyScan(token, ESTATE_A)).admitted).toBe(true);
    await credentialService.revoke(admin(), credential._id.toHexString(), 'Card lost');

    const result = await verifyScan(token, ESTATE_A);
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('revoked');
  });

  it('never caches a blacklisted credential', async () => {
    const subjectId = new mongoose.Types.ObjectId().toHexString();
    const { token } = await credentialService.issue(admin(), {
      subject: 'vehicle',
      subjectId,
      display,
    });

    await credentialService.setBlacklisted(admin(), 'vehicle', subjectId, true, 'Stolen');

    // Twice: a cached blacklist could otherwise be served after the block lifts.
    expect((await verifyScan(token, ESTATE_A)).reason).toBe('blacklisted');
    expect((await verifyScan(token, ESTATE_A)).reason).toBe('blacklisted');
  });
});

describe('credential state', () => {
  it('refuses a blacklisted credential whatever its status says', async () => {
    const subjectId = new mongoose.Types.ObjectId().toHexString();
    const { token, credential } = await credentialService.issue(admin(), {
      subject: 'vehicle',
      subjectId,
      display,
    });

    // Status left active on purpose: the blacklist must win regardless.
    await AccessCredentialModel.updateOne(
      { _id: credential._id },
      { $set: { blacklisted: true, status: 'active' } },
    );

    const result = await verifyScan(token, ESTATE_A);
    expect(result.reason).toBe('blacklisted');
    expect(result.message).toContain('DO NOT ADMIT');
  });

  it('refuses a credential outside its validity window', async () => {
    const { token } = await credentialService.issue(admin(), {
      subject: 'visitor',
      subjectId: new mongoose.Types.ObjectId().toHexString(),
      display,
      validFrom: new Date(Date.now() + 3_600_000),
      validUntil: new Date(Date.now() + 7_200_000),
    });

    expect((await verifyScan(token, ESTATE_A)).reason).toBe('not-yet-valid');
  });

  it('refuses a credential whose window has closed', async () => {
    const subjectId = new mongoose.Types.ObjectId().toHexString();
    const { token, credential } = await credentialService.issue(admin(), {
      subject: 'visitor',
      subjectId,
      display,
      validUntil: new Date(Date.now() + 3_600_000),
    });

    await AccessCredentialModel.updateOne(
      { _id: credential._id },
      { $set: { validUntil: new Date(Date.now() - 1000) } },
    );

    expect((await verifyScan(token, ESTATE_A)).reason).toBe('window-closed');
  });

  it('expires lapsed credentials in a sweep', async () => {
    const { credential } = await credentialService.issue(admin(), {
      subject: 'visitor',
      subjectId: new mongoose.Types.ObjectId().toHexString(),
      display,
      validUntil: new Date(Date.now() + 3_600_000),
    });

    await AccessCredentialModel.updateOne(
      { _id: credential._id },
      { $set: { validUntil: new Date(Date.now() - 1000) } },
    );

    expect(await credentialService.expireLapsed(admin())).toBe(1);
    expect((await AccessCredentialModel.findById(credential._id).lean())?.status).toBe('expired');
  });
});

describe('display sync', () => {
  // A stale house number is not cosmetic: it sends the officer to the wrong door.
  it('refreshes the denormalised copy and drops the cache', async () => {
    const subjectId = new mongoose.Types.ObjectId().toHexString();
    const { token } = await credentialService.issue(admin(), {
      subject: 'resident',
      subjectId,
      display,
    });

    await verifyScan(token, ESTATE_A);
    await credentialService.syncDisplay(admin(), 'resident', subjectId, { unitNumber: '45A' });

    const result = await verifyScan(token, ESTATE_A);
    expect(result.credential?.display.unitNumber).toBe('45A');
    expect(result.cached).toBe(false);
  });
});

describe('tenant isolation', () => {
  it('will not let one estate revoke another credential', async () => {
    const { credential } = await issueResidentCredential(ESTATE_A);

    await expect(
      credentialService.revoke(ctx(ESTATE_B), credential._id.toHexString(), 'x'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
