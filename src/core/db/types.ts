import type { ClientSession, Types } from 'mongoose';

/** Fields every tenant-scoped document carries. */
export interface TenantDocument {
  _id: Types.ObjectId;
  estateId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Soft-delete marker. Historical relationships — a departed tenant, a
   * transferred property, a revoked pass — are retained rather than removed,
   * because gate logs, audit trails and disputes need to resolve them later.
   */
  deletedAt?: Date | null;
}

export interface PaginationInput {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface QueryOptions {
  /** Include soft-deleted records. Requires a deliberate call-site decision. */
  includeDeleted?: boolean;
  sort?: Record<string, 1 | -1>;
  /** Projection — use to avoid pulling encrypted fields into memory needlessly. */
  select?: string;
  session?: ClientSession;
}

export const DEFAULT_PAGE_SIZE = 25;
/** Hard ceiling, so a crafted `?limit=100000` cannot be used to exhaust memory. */
export const MAX_PAGE_SIZE = 100;
