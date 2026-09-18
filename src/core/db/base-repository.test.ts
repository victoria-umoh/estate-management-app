/**
 * Tenant isolation is the single most important property of this system: one
 * estate must never be able to read, modify or delete another's data.
 *
 * These tests run against a real MongoDB replica set rather than a mock,
 * because the guarantee depends on how queries actually execute — a mock would
 * only re-assert the implementation back at itself.
 */
import mongoose, { Schema, type Model } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import type { RequestContext } from '@/core/tenancy';
import { BaseRepository } from './base-repository';
import type { TenantDocument } from './types';

setupTestDatabase();

interface WidgetDoc extends TenantDocument {
  name: string;
  status: string;
}

const widgetSchema = new Schema<WidgetDoc>(
  {
    estateId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true },
    status: { type: String, default: 'active' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const WidgetModel: Model<WidgetDoc> =
  (mongoose.models.Widget as Model<WidgetDoc>) ?? mongoose.model<WidgetDoc>('Widget', widgetSchema);

class WidgetRepository extends BaseRepository<WidgetDoc> {
  constructor() {
    super(WidgetModel);
  }
}

const repo = new WidgetRepository();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

function ctx(estateId: string, overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'user-1',
    estateId,
    roles: ['admin'],
    permissions: new Set(['*']),
    correlationId: 'test',
    isPlatformAdmin: false,
    ...overrides,
  };
}

const a = ctx(ESTATE_A);
const b = ctx(ESTATE_B);

describe('BaseRepository — tenant isolation', () => {
  let widgetA: WidgetDoc;

  beforeEach(async () => {
    widgetA = await repo.create(a, { name: 'Estate A widget' });
    await repo.create(b, { name: 'Estate B widget' });
  });

  it('stamps the estate from the context on create', async () => {
    expect(widgetA.estateId.toHexString()).toBe(ESTATE_A);
  });

  it('only returns the calling estate records', async () => {
    const forA = await repo.findMany(a);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.name).toBe('Estate A widget');
  });

  // 404 rather than 403: returning 403 would confirm the id exists elsewhere,
  // letting an attacker enumerate another estate's records by probing ids.
  it('reports another estate record as not found', async () => {
    expect(await repo.findById(b, widgetA._id)).toBeNull();
    await expect(repo.findByIdOrFail(b, widgetA._id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('cannot update another estate record', async () => {
    await expect(
      repo.updateById(b, widgetA._id, { $set: { name: 'hijacked' } }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const untouched = await repo.findByIdOrFail(a, widgetA._id);
    expect(untouched.name).toBe('Estate A widget');
  });

  it('cannot delete another estate record', async () => {
    await expect(repo.softDelete(b, widgetA._id)).rejects.toMatchObject({ statusCode: 404 });
    await repo.hardDelete(b, widgetA._id);
    expect(await repo.findById(a, widgetA._id)).not.toBeNull();
  });

  it('scopes counts, existence checks and bulk updates', async () => {
    expect(await repo.count(a)).toBe(1);
    expect(await repo.exists(b, { name: 'Estate A widget' })).toBe(false);
    expect(await repo.updateMany(b, { name: 'Estate A widget' }, { $set: { status: 'x' } })).toBe(
      0,
    );
  });

  it('scopes pagination totals, so counts cannot leak volume', async () => {
    await repo.createMany(
      b,
      Array.from({ length: 10 }, (_, i) => ({ name: `B ${i}` })),
    );

    const page = await repo.paginate(a, {}, { page: 1, limit: 10 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });

  // A $match on estateId placed after a $group would aggregate across every
  // estate and only then filter the blended result.
  it('forces the tenant filter into the first aggregation stage', async () => {
    await repo.createMany(b, [{ name: 'x' }, { name: 'y' }]);

    const result = await repo.aggregate<{ _id: null; total: number }>(a, [
      { $group: { _id: null, total: { $sum: 1 } } },
    ]);

    expect(result[0]?.total).toBe(1);
  });
});

describe('BaseRepository — escaping the boundary', () => {
  it('rejects a filter that supplies its own estateId', async () => {
    await expect(
      repo.findMany(a, { estateId: new mongoose.Types.ObjectId(ESTATE_B) } as never),
    ).rejects.toThrow(/must not set estateId/);
  });

  // Without this, an update could move a record out of the caller's tenant —
  // a write-side escape from the boundary the read side enforces.
  it('rejects an update that reassigns estateId', async () => {
    const widget = await repo.create(a, { name: 'w' });

    await expect(
      repo.updateById(a, widget._id, { $set: { estateId: ESTATE_B } } as never),
    ).rejects.toThrow(/estateId cannot be changed/);

    await expect(repo.updateById(a, widget._id, { estateId: ESTATE_B } as never)).rejects.toThrow(
      /estateId cannot be changed/,
    );
  });

  it('rejects an update that reassigns _id', async () => {
    const widget = await repo.create(a, { name: 'w' });
    await expect(
      repo.updateById(a, widget._id, { $set: { _id: new mongoose.Types.ObjectId() } } as never),
    ).rejects.toThrow(/_id cannot be changed/);
  });

  // $where executes server-side JavaScript.
  it('rejects the $where operator', async () => {
    await expect(repo.findMany(a, { $where: 'true' } as never)).rejects.toThrow(/\$where/);
  });

  it.each([
    ['an empty estateId', ''],
    ['a whitespace estateId', '   '],
  ])('refuses to run with %s', async (_label, estateId) => {
    await expect(repo.findMany(ctx(estateId))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a missing context entirely', async () => {
    await expect(repo.findMany(undefined as never)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('BaseRepository — soft deletion', () => {
  it('hides soft-deleted records by default but retains them', async () => {
    const widget = await repo.create(a, { name: 'departing tenant' });
    await repo.softDelete(a, widget._id);

    expect(await repo.findById(a, widget._id)).toBeNull();
    expect(await repo.count(a)).toBe(0);

    // The record still exists — gate logs and audit trails must be able to
    // resolve it later.
    const retained = await repo.findById(a, widget._id, { includeDeleted: true });
    expect(retained?.name).toBe('departing tenant');
    expect(retained?.deletedAt).toBeInstanceOf(Date);
  });

  it('restores a soft-deleted record', async () => {
    const widget = await repo.create(a, { name: 'w' });
    await repo.softDelete(a, widget._id);
    await repo.restore(a, widget._id);

    expect(await repo.findById(a, widget._id)).not.toBeNull();
  });

  it('keeps soft deletion scoped to the estate', async () => {
    const widget = await repo.create(a, { name: 'w' });
    await repo.softDelete(a, widget._id);

    await expect(repo.restore(b, widget._id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('BaseRepository — pagination limits', () => {
  beforeEach(async () => {
    await repo.createMany(
      a,
      Array.from({ length: 30 }, (_, i) => ({ name: `w${i}` })),
    );
  });

  it('caps page size so a crafted limit cannot exhaust memory', async () => {
    const page = await repo.paginate(a, {}, { limit: 100_000 });
    expect(page.limit).toBe(100);
  });

  it('normalises nonsensical pagination input', async () => {
    const page = await repo.paginate(a, {}, { page: -5, limit: 0 });
    expect(page.page).toBe(1);
    expect(page.limit).toBeGreaterThan(0);
  });

  it('reports page metadata', async () => {
    const page = await repo.paginate(a, {}, { page: 2, limit: 10 });
    expect(page).toMatchObject({ total: 30, page: 2, limit: 10, totalPages: 3, hasNextPage: true });
    expect(await repo.paginate(a, {}, { page: 3, limit: 10 })).toMatchObject({
      hasNextPage: false,
    });
  });
});

describe('BaseRepository — invalid identifiers', () => {
  // A malformed id is indistinguishable from a non-existent one and should not
  // be a separate signal to a probing caller.
  it('treats a malformed id as not found', async () => {
    await expect(repo.findByIdOrFail(a, 'not-an-object-id')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
