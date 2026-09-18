import { Types } from 'mongoose';
import { PlatformRepository } from '@/core/db';
import { SessionModel, type SessionDoc, type SessionRevocationReason } from './session.schema';

/**
 * Sessions are looked up by refresh-token hash before any estate context
 * exists, so this extends PlatformRepository. Each document still carries the
 * estate it operates in, which becomes the tenant context once resolved.
 */
export class SessionRepository extends PlatformRepository<SessionDoc> {
  constructor() {
    super(SessionModel);
  }

  findByRefreshTokenHash(hash: string): Promise<SessionDoc | null> {
    return this.findOne({ refreshTokenHash: hash });
  }

  /**
   * Find a session whose PREVIOUS token matches.
   *
   * A hit means someone presented a token that has already been rotated away —
   * the signature of a stolen refresh token being replayed.
   */
  findByPreviousTokenHash(hash: string): Promise<SessionDoc | null> {
    return this.findOne({ previousTokenHash: hash });
  }

  listActiveForUser(userId: string | Types.ObjectId): Promise<SessionDoc[]> {
    return this.findMany(
      { userId: new Types.ObjectId(userId), revokedAt: null, expiresAt: { $gt: new Date() } },
      { sort: { lastUsedAt: -1 } },
    );
  }

  async revoke(sessionId: string | Types.ObjectId, reason: SessionRevocationReason): Promise<void> {
    await this.updateById(sessionId, { $set: { revokedAt: new Date(), revokedReason: reason } });
  }

  /**
   * Revoke every session for a user.
   *
   * Used on password change, on administrative revocation, and on detected
   * refresh-token reuse — where the point is to evict the attacker even at the
   * cost of signing the legitimate user out.
   */
  async revokeAllForUser(
    userId: string | Types.ObjectId,
    reason: SessionRevocationReason,
    except?: string | Types.ObjectId,
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
      revokedAt: null,
    };
    if (except) filter._id = { $ne: new Types.ObjectId(except) };

    return this.updateMany(filter, {
      $set: { revokedAt: new Date(), revokedReason: reason },
    });
  }
}

export const sessionRepository = new SessionRepository();
