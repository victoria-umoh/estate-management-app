import {
  Types,
  type FilterQuery,
  type Model,
  type PipelineStage,
  type UpdateQuery,
} from 'mongoose';
import { InternalError, NotFoundError } from '@/core/errors';
import { assertTenantContext, type RequestContext } from '@/core/tenancy';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type PaginatedResult,
  type PaginationInput,
  type QueryOptions,
  type TenantDocument,
} from './types';

/**
 * Tenant-scoped data access.
 *
 * THIS CLASS IS THE TENANT BOUNDARY. Every read and write funnels through
 * `scope()`, which stamps `estateId` onto the filter. There is deliberately no
 * method that takes a raw filter and runs it unscoped — cross-estate access
 * requires the separate, explicitly-named PlatformRepository, so it shows up in
 * code review instead of hiding in a forgotten `where` clause.
 *
 * The ESLint layering rule stops anything outside a repository importing a
 * Mongoose model, which is what keeps this the only path to the data.
 */
export abstract class BaseRepository<TDoc extends TenantDocument> {
  protected constructor(protected readonly model: Model<TDoc>) {}

  // ---------------------------------------------------------------------------
  // Scoping
  // ---------------------------------------------------------------------------

  /**
   * Apply the tenant filter.
   *
   * Throws if the caller tries to supply its own `estateId`. That is either a
   * bug or an attempt to escape the tenant boundary; silently overwriting it
   * would hide both.
   */
  protected scope(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    options: QueryOptions = {},
  ): FilterQuery<TDoc> {
    assertTenantContext(context);

    if ('estateId' in filter) {
      throw new InternalError(
        'Repository filters must not set estateId — it is applied from the request context.',
      );
    }

    // `$where` accepts server-side JavaScript. It is never needed here and is a
    // code-execution risk if any part of a filter derives from user input.
    if ('$where' in filter) {
      throw new InternalError('The $where operator is not permitted.');
    }

    const scoped = {
      ...filter,
      estateId: this.toObjectId(context.estateId),
    } as FilterQuery<TDoc>;

    // Soft-deleted records are excluded unless explicitly requested, so a
    // departed tenant does not reappear in the resident directory.
    if (!options.includeDeleted) {
      (scoped as Record<string, unknown>).deletedAt = null;
    }

    return scoped;
  }

  protected toObjectId(id: string | Types.ObjectId): Types.ObjectId {
    if (id instanceof Types.ObjectId) return id;
    if (!Types.ObjectId.isValid(id)) {
      // Surfaced as 404 rather than 400: a malformed id is indistinguishable
      // from a non-existent one, and should not be a separate signal.
      throw new NotFoundError('Record');
    }
    return new Types.ObjectId(id);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findById(
    context: RequestContext,
    id: string | Types.ObjectId,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    const filter = this.scope(context, { _id: this.toObjectId(id) } as FilterQuery<TDoc>, options);
    return this.model
      .findOne(filter, options.select, { session: options.session })
      .lean<TDoc>()
      .exec();
  }

  /**
   * Fetch by id or throw 404.
   *
   * A record belonging to another estate is not found here, which is exactly
   * the intended behaviour: 404 rather than 403 avoids confirming that the id
   * exists somewhere else.
   */
  async findByIdOrFail(
    context: RequestContext,
    id: string | Types.ObjectId,
    options: QueryOptions = {},
  ): Promise<TDoc> {
    const found = await this.findById(context, id, options);
    if (!found) throw new NotFoundError(this.model.modelName);
    return found;
  }

  async findOne(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    return this.model
      .findOne(this.scope(context, filter, options), options.select, {
        session: options.session,
        sort: options.sort,
      })
      .lean<TDoc>()
      .exec();
  }

  async findOneOrFail(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    options: QueryOptions = {},
  ): Promise<TDoc> {
    const found = await this.findOne(context, filter, options);
    if (!found) throw new NotFoundError(this.model.modelName);
    return found;
  }

  async findMany(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    options: QueryOptions = {},
  ): Promise<TDoc[]> {
    return this.model
      .find(this.scope(context, filter, options), options.select, {
        session: options.session,
        sort: options.sort,
      })
      .lean<TDoc[]>()
      .exec();
  }

  /** Offset pagination with a hard page-size ceiling. */
  async paginate(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    pagination: PaginationInput = {},
    options: QueryOptions = {},
  ): Promise<PaginatedResult<TDoc>> {
    const page = Math.max(1, Math.floor(pagination.page ?? 1));
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(pagination.limit ?? DEFAULT_PAGE_SIZE)),
    );

    const scoped = this.scope(context, filter, options);

    const [items, total] = await Promise.all([
      this.model
        .find(scoped, options.select, { session: options.session, sort: options.sort })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<TDoc[]>()
        .exec(),
      this.model
        .countDocuments(scoped)
        .session(options.session ?? null)
        .exec(),
    ]);

    const totalPages = Math.ceil(total / limit);

    return { items, total, page, limit, totalPages, hasNextPage: page < totalPages };
  }

  async count(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    options: QueryOptions = {},
  ): Promise<number> {
    return this.model
      .countDocuments(this.scope(context, filter, options))
      .session(options.session ?? null)
      .exec();
  }

  async exists(
    context: RequestContext,
    filter: FilterQuery<TDoc> = {},
    options: QueryOptions = {},
  ): Promise<boolean> {
    const found = await this.model
      .exists(this.scope(context, filter, options))
      .session(options.session ?? null)
      .exec();
    return found !== null;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(
    context: RequestContext,
    data: Omit<Partial<TDoc>, 'estateId' | '_id'>,
    options: QueryOptions = {},
  ): Promise<TDoc> {
    assertTenantContext(context);

    const [created] = await this.model.create(
      [{ ...data, estateId: this.toObjectId(context.estateId) }],
      { session: options.session },
    );

    if (!created) throw new InternalError('Failed to create record.');
    return created.toObject() as TDoc;
  }

  async createMany(
    context: RequestContext,
    records: Array<Omit<Partial<TDoc>, 'estateId' | '_id'>>,
    options: QueryOptions = {},
  ): Promise<TDoc[]> {
    assertTenantContext(context);
    if (records.length === 0) return [];

    const estateId = this.toObjectId(context.estateId);
    const created = await this.model.insertMany(
      records.map((record) => ({ ...record, estateId })),
      { session: options.session },
    );

    return created.map((doc) => doc.toObject() as TDoc);
  }

  async updateById(
    context: RequestContext,
    id: string | Types.ObjectId,
    update: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<TDoc> {
    const updated = await this.model
      .findOneAndUpdate(
        this.scope(context, { _id: this.toObjectId(id) } as FilterQuery<TDoc>, options),
        this.guardUpdate(update),
        { new: true, session: options.session, runValidators: true },
      )
      .lean<TDoc>()
      .exec();

    if (!updated) throw new NotFoundError(this.model.modelName);
    return updated;
  }

  async updateOne(
    context: RequestContext,
    filter: FilterQuery<TDoc>,
    update: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    return this.model
      .findOneAndUpdate(this.scope(context, filter, options), this.guardUpdate(update), {
        new: true,
        session: options.session,
        runValidators: true,
      })
      .lean<TDoc>()
      .exec();
  }

  async updateMany(
    context: RequestContext,
    filter: FilterQuery<TDoc>,
    update: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<number> {
    const result = await this.model
      .updateMany(this.scope(context, filter, options), this.guardUpdate(update), {
        session: options.session,
        runValidators: true,
      })
      .exec();
    return result.modifiedCount;
  }

  /**
   * Stop an update reassigning a record to another estate.
   *
   * Without this, `updateById(ctx, id, { estateId: otherEstate })` would move a
   * resident out of the caller's tenant — a write-side escape from the boundary
   * the read side carefully enforces.
   */
  private guardUpdate(update: UpdateQuery<TDoc>): UpdateQuery<TDoc> {
    const setters = (update.$set ?? {}) as Record<string, unknown>;

    if ('estateId' in update || 'estateId' in setters) {
      throw new InternalError('estateId cannot be changed by an update.');
    }
    if ('_id' in update || '_id' in setters) {
      throw new InternalError('_id cannot be changed by an update.');
    }

    return update;
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  /**
   * Soft delete — the default. Preserves the record for audit trails, gate
   * history and dispute resolution.
   */
  async softDelete(
    context: RequestContext,
    id: string | Types.ObjectId,
    options: QueryOptions = {},
  ): Promise<TDoc> {
    const deleted = await this.model
      .findOneAndUpdate(
        this.scope(context, { _id: this.toObjectId(id) } as FilterQuery<TDoc>, options),
        { $set: { deletedAt: new Date() } } as UpdateQuery<TDoc>,
        { new: true, session: options.session },
      )
      .lean<TDoc>()
      .exec();

    if (!deleted) throw new NotFoundError(this.model.modelName);
    return deleted;
  }

  async restore(
    context: RequestContext,
    id: string | Types.ObjectId,
    options: QueryOptions = {},
  ): Promise<TDoc> {
    const restored = await this.model
      .findOneAndUpdate(
        this.scope(context, { _id: this.toObjectId(id) } as FilterQuery<TDoc>, {
          ...options,
          includeDeleted: true,
        }),
        { $set: { deletedAt: null } } as UpdateQuery<TDoc>,
        { new: true, session: options.session },
      )
      .lean<TDoc>()
      .exec();

    if (!restored) throw new NotFoundError(this.model.modelName);
    return restored;
  }

  /**
   * Permanent deletion. Reserved for data-retention enforcement and tests —
   * ordinary application flows soft delete.
   */
  async hardDelete(
    context: RequestContext,
    id: string | Types.ObjectId,
    options: QueryOptions = {},
  ): Promise<void> {
    await this.model
      .deleteOne(
        this.scope(context, { _id: this.toObjectId(id) } as FilterQuery<TDoc>, {
          ...options,
          includeDeleted: true,
        }),
      )
      .session(options.session ?? null)
      .exec();
  }

  // ---------------------------------------------------------------------------
  // Aggregation
  // ---------------------------------------------------------------------------

  /**
   * Run an aggregation with the tenant filter forced into the FIRST stage.
   *
   * Stage order matters for correctness as well as performance: a `$match` on
   * estateId placed after a `$group` would aggregate across every estate and
   * then filter the already-blended result.
   */
  async aggregate<TResult = Record<string, unknown>>(
    context: RequestContext,
    pipeline: PipelineStage[],
    options: QueryOptions = {},
  ): Promise<TResult[]> {
    assertTenantContext(context);

    const match: Record<string, unknown> = { estateId: this.toObjectId(context.estateId) };
    if (!options.includeDeleted) match.deletedAt = null;

    return this.model
      .aggregate<TResult>([{ $match: match } as PipelineStage.Match, ...pipeline])
      .session(options.session ?? null)
      .exec();
  }
}
