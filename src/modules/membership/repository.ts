import { Types } from 'mongoose';
import { BaseRepository } from '@/core/db';
import { MembershipModel, type MembershipDoc } from './schema';

export class MembershipRepository extends BaseRepository<MembershipDoc> {
  constructor() {
    super(MembershipModel);
  }

  /**
   * Every estate a user belongs to.
   *
   * Deliberately bypasses the tenant guard — it is the one query that must run
   * before an estate is known, because its answer is what establishes the
   * estate context at login. It is scoped tightly to a single userId and
   * returns nothing about any other user, so it cannot be used to enumerate.
   */
  async findEstatesForUser(userId: string | Types.ObjectId): Promise<MembershipDoc[]> {
    return MembershipModel.find({
      userId: new Types.ObjectId(userId),
      status: { $in: ['active', 'awaiting-approval', 'pending'] },
      deletedAt: null,
    })
      .lean<MembershipDoc[]>()
      .exec();
  }

  /**
   * A membership still waiting on email verification.
   *
   * Like `findEstatesForUser`, this runs before an estate context exists,
   * which is unavoidable: the caller is holding an email address and nothing
   * else. It is scoped to one userId and returns only a pending row, so it
   * answers nothing about any other user.
   */
  async findPendingForUser(userId: string | Types.ObjectId): Promise<MembershipDoc | null> {
    return MembershipModel.findOne({
      userId: new Types.ObjectId(userId),
      status: 'pending',
      deletedAt: null,
    })
      .lean<MembershipDoc>()
      .exec();
  }

  /** One membership, looked up without an estate context. Used by the token path. */
  async findByUserAndEstate(
    userId: string | Types.ObjectId,
    estateId: string | Types.ObjectId,
  ): Promise<MembershipDoc | null> {
    return MembershipModel.findOne({
      userId: new Types.ObjectId(userId),
      estateId: new Types.ObjectId(estateId),
      deletedAt: null,
    })
      .lean<MembershipDoc>()
      .exec();
  }
}

export const membershipRepository = new MembershipRepository();
