import { Types, type FilterQuery, type Model, type UpdateQuery } from 'mongoose';
import { NotFoundError } from '@/core/errors';
import type { QueryOptions } from './types';

/**
 * Data access for collections that are NOT scoped to a single estate.
 *
 * Deliberately a separate class from BaseRepository, with a name that stands
 * out in review. Global collections are the exception — user accounts,
 * subscription plans, platform audit — and every one of them is a place where
 * tenant isolation does not apply by construction rather than by accident.
 *
 * Anything a resident owns belongs in a tenant-scoped repository instead.
 *
 * `users` lives here because login happens BEFORE an estate is known: the
 * caller supplies an email, and which estates they belong to is the answer, not
 * the question. Estate-specific facts about a person live in `memberships`,
 * which IS tenant-scoped.
 */
export abstract class PlatformRepository<TDoc extends { _id: Types.ObjectId }> {
  protected constructor(protected readonly model: Model<TDoc>) {}

  protected toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    if (id instanceof Types.ObjectId) return id;
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Record');
    return new Types.ObjectId(id);
  }

  /** Reject `$where`, which executes server-side JavaScript. */
  protected guard(filter: FilterQuery<TDoc>): FilterQuery<TDoc> {
    if ('$where' in filter) throw new Error('The $where operator is not permitted.');
    return filter;
  }

  async findById(id: string | Types.ObjectId, options: QueryOptions = {}): Promise<TDoc | null> {
    return this.model
      .findOne({ _id: this.toObjectId(id) } as FilterQuery<TDoc>, options.select, {
        session: options.session,
      })
      .lean<TDoc>()
      .exec();
  }

  async findByIdOrFail(id: string | Types.ObjectId, options: QueryOptions = {}): Promise<TDoc> {
    const found = await this.findById(id, options);
    if (!found) throw new NotFoundError(this.model.modelName);
    return found;
  }

  async findOne(filter: FilterQuery<TDoc>, options: QueryOptions = {}): Promise<TDoc | null> {
    return this.model
      .findOne(this.guard(filter), options.select, { session: options.session, sort: options.sort })
      .lean<TDoc>()
      .exec();
  }

  async findMany(filter: FilterQuery<TDoc> = {}, options: QueryOptions = {}): Promise<TDoc[]> {
    return this.model
      .find(this.guard(filter), options.select, { session: options.session, sort: options.sort })
      .lean<TDoc[]>()
      .exec();
  }

  async exists(filter: FilterQuery<TDoc>, options: QueryOptions = {}): Promise<boolean> {
    const found = await this.model
      .exists(this.guard(filter))
      .session(options.session ?? null)
      .exec();
    return found !== null;
  }

  async count(filter: FilterQuery<TDoc> = {}, options: QueryOptions = {}): Promise<number> {
    return this.model
      .countDocuments(this.guard(filter))
      .session(options.session ?? null)
      .exec();
  }

  async create(data: Partial<TDoc>, options: QueryOptions = {}): Promise<TDoc> {
    const [created] = await this.model.create([data], { session: options.session });
    return created!.toObject() as TDoc;
  }

  async updateById(
    id: string | Types.ObjectId,
    update: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<TDoc> {
    const updated = await this.model
      .findOneAndUpdate({ _id: this.toObjectId(id) } as FilterQuery<TDoc>, update, {
        new: true,
        session: options.session,
        runValidators: true,
      })
      .lean<TDoc>()
      .exec();

    if (!updated) throw new NotFoundError(this.model.modelName);
    return updated;
  }

  async updateOne(
    filter: FilterQuery<TDoc>,
    update: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    return this.model
      .findOneAndUpdate(this.guard(filter), update, {
        new: true,
        session: options.session,
        runValidators: true,
      })
      .lean<TDoc>()
      .exec();
  }

  async updateMany(
    filter: FilterQuery<TDoc>,
    update: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<number> {
    const result = await this.model
      .updateMany(this.guard(filter), update, { session: options.session })
      .exec();
    return result.modifiedCount;
  }

  async deleteById(id: string | Types.ObjectId, options: QueryOptions = {}): Promise<void> {
    await this.model
      .deleteOne({ _id: this.toObjectId(id) } as FilterQuery<TDoc>)
      .session(options.session ?? null)
      .exec();
  }
}
