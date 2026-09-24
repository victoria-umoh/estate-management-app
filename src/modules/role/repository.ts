import type { Types } from 'mongoose';
import { BaseRepository, type QueryOptions } from '@/core/db';
import type { RequestContext } from '@/core/tenancy';
import { RoleModel, type RoleDoc } from './schema';

export class RoleRepository extends BaseRepository<RoleDoc> {
  constructor() {
    super(RoleModel);
  }

  findByCode(
    context: RequestContext,
    code: string,
    options: QueryOptions = {},
  ): Promise<RoleDoc | null> {
    return this.findOne(context, { code: code.toLowerCase() }, options);
  }

  findByIds(context: RequestContext, ids: Types.ObjectId[]): Promise<RoleDoc[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.findMany(context, { _id: { $in: ids } });
  }

  /**
   * Resolve a membership's roles without an estate context.
   *
   * Used during login, when the roles being fetched are what establish the
   * context in the first place. Scoped to a single explicit estate id and to
   * the ids already recorded on that membership, so it cannot read another
   * estate's roles.
   */
  async resolveForLogin(estateId: Types.ObjectId, roleIds: Types.ObjectId[]): Promise<RoleDoc[]> {
    if (roleIds.length === 0) return [];

    return RoleModel.find({ estateId, _id: { $in: roleIds }, deletedAt: null })
      .lean<RoleDoc[]>()
      .exec();
  }
}

export const roleRepository = new RoleRepository();
