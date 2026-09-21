import { Types } from 'mongoose';
import { hashToken, issueToken, type TokenSubject } from '@/core/crypto';
import { BaseRepository, withTransaction } from '@/core/db';
import { events } from '@/core/events';
import { NotFoundError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { AccessCredentialModel, type AccessCredentialDoc } from './schema';
import { invalidateCachedCredential } from './verification';

const log = createLogger('credential');

class CredentialRepository extends BaseRepository<AccessCredentialDoc> {
  constructor() {
    super(AccessCredentialModel);
  }

  findActiveFor(
    context: RequestContext,
    subject: TokenSubject,
    subjectId: string,
  ): Promise<AccessCredentialDoc | null> {
    return this.findOne(context, {
      subject,
      subjectId: new Types.ObjectId(subjectId),
      status: 'active',
    });
  }
}

export const credentialRepository = new CredentialRepository();

export interface IssueCredentialInput {
  subject: TokenSubject;
  subjectId: string;
  display: AccessCredentialDoc['display'];
  validFrom?: Date;
  validUntil?: Date;
  /** Token lifetime. Defaults to the validity window, or one year. */
  ttlSeconds?: number;
}

/**
 * Issuing, rotating and revoking gate credentials.
 *
 * A credential is the thing that actually opens a gate, so every state change
 * here does two things together: update the record, and drop the cached copy.
 * Doing only the first leaves a revoked pass working until its cache entry
 * expires.
 */
export class CredentialService {
  /**
   * Issue a credential, superseding any active one for the same subject.
   *
   * Reissuing is how a lost ID is handled: the old token stops working the
   * moment the new one exists, without needing to find the physical card.
   */
  async issue(
    context: RequestContext,
    input: IssueCredentialInput,
  ): Promise<{ token: string; credential: AccessCredentialDoc }> {
    const validFrom = input.validFrom ?? new Date();
    const validUntil = input.validUntil ?? null;

    const ttlSeconds =
      input.ttlSeconds ??
      (validUntil
        ? Math.max(60, Math.ceil((validUntil.getTime() - Date.now()) / 1000))
        : 365 * 24 * 3600);

    const { token, payload } = issueToken({
      sub: input.subject,
      // The credential id is not yet known, so the token carries its own jti and
      // the row is located by token hash. The two are bound by the hash itself.
      cid: new Types.ObjectId().toHexString(),
      est: context.estateId,
      ttlSeconds,
    });

    return withTransaction(async (session) => {
      const existing = await credentialRepository.findActiveFor(
        context,
        input.subject,
        input.subjectId,
      );

      let version = 1;

      if (existing) {
        version = existing.version + 1;

        await credentialRepository.updateById(
          context,
          existing._id,
          { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'superseded' } },
          { session },
        );
        // Outside the transaction's guarantees, but harmless if it runs twice
        // and essential that it runs at all.
        await invalidateCachedCredential(existing.tokenHash);
      }

      const credential = await credentialRepository.create(
        context,
        {
          tokenHash: hashToken(token),
          jti: payload.jti,
          subject: input.subject,
          subjectId: new Types.ObjectId(input.subjectId),
          display: input.display,
          status: 'active',
          blacklisted: false,
          validFrom,
          validUntil,
          version,
          issuedAt: new Date(),
          issuedBy: new Types.ObjectId(context.userId),
          syncedAt: new Date(),
        },
        { session },
      );

      await auditService.record(context, {
        action: 'credential.issued',
        resource: 'credential',
        resourceId: credential._id,
        metadata: {
          subject: input.subject,
          subjectId: input.subjectId,
          version,
          supersededVersion: existing?.version ?? null,
        },
        session,
      });

      events.emit('credential.issued', {
        credentialId: credential._id.toHexString(),
        estateId: context.estateId,
        subject: input.subject,
      });

      log.info(
        { subject: input.subject, subjectId: input.subjectId, version },
        'credential issued',
      );

      // The token is returned exactly once. Only its hash is stored, so it
      // cannot be recovered later — a lost pass is reissued, not retrieved.
      return { token, credential };
    });
  }

  async revoke(context: RequestContext, credentialId: string, reason: string): Promise<void> {
    const credential = await credentialRepository.findByIdOrFail(context, credentialId);

    await credentialRepository.updateById(context, credentialId, {
      $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason },
    });

    await invalidateCachedCredential(credential.tokenHash);

    await auditService.record(context, {
      action: 'credential.revoked',
      resource: 'credential',
      resourceId: credentialId,
      metadata: { subject: credential.subject, reason },
    });

    events.emit('credential.revoked', {
      credentialId,
      estateId: context.estateId,
      reason,
    });
  }

  /**
   * Block a credential outright.
   *
   * Separate from revocation because it carries a different instruction to the
   * officer: revoked means "this pass is no longer valid", blacklisted means
   * "do not admit this person or vehicle, and call security".
   */
  async setBlacklisted(
    context: RequestContext,
    subject: TokenSubject,
    subjectId: string,
    blacklisted: boolean,
    reason?: string,
  ): Promise<void> {
    const credential = await credentialRepository.findActiveFor(context, subject, subjectId);
    if (!credential) return;

    await credentialRepository.updateById(context, credential._id, {
      $set: {
        blacklisted,
        blacklistReason: blacklisted ? (reason ?? 'Not specified') : null,
        syncedAt: new Date(),
      },
    });

    // Must happen immediately: a cached copy would otherwise keep admitting for
    // the remainder of its TTL.
    await invalidateCachedCredential(credential.tokenHash);
  }

  /**
   * Refresh the denormalised display copy from its source record.
   *
   * Called by event handlers when a name, house number or photo changes.
   * Without it the gate would keep showing the old details — which for a house
   * number is not cosmetic, it is the officer sending someone to the wrong door.
   */
  async syncDisplay(
    context: RequestContext,
    subject: TokenSubject,
    subjectId: string,
    display: Partial<AccessCredentialDoc['display']>,
  ): Promise<void> {
    const credential = await credentialRepository.findActiveFor(context, subject, subjectId);
    if (!credential) return;

    await credentialRepository.updateById(context, credential._id, {
      $set: {
        ...Object.fromEntries(
          Object.entries(display).map(([key, value]) => [`display.${key}`, value]),
        ),
        syncedAt: new Date(),
      },
    });

    await invalidateCachedCredential(credential.tokenHash);
  }

  /** Expire credentials whose window has closed. Run by a scheduled sweep. */
  async expireLapsed(context: RequestContext): Promise<number> {
    const lapsed = await credentialRepository.findMany(context, {
      status: 'active',
      validUntil: { $ne: null, $lte: new Date() },
    });

    for (const credential of lapsed) {
      await invalidateCachedCredential(credential.tokenHash);
    }

    return credentialRepository.updateMany(
      context,
      { status: 'active', validUntil: { $ne: null, $lte: new Date() } },
      { $set: { status: 'expired' } },
    );
  }

  async findForSubject(
    context: RequestContext,
    subject: TokenSubject,
    subjectId: string,
  ): Promise<AccessCredentialDoc> {
    const credential = await credentialRepository.findActiveFor(context, subject, subjectId);
    if (!credential) throw new NotFoundError('Credential');
    return credential;
  }
}

export const credentialService = new CredentialService();
