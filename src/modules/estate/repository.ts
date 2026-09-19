import { PlatformRepository } from '@/core/db';
import { EstateModel, type EstateDoc } from './schema';

/**
 * Estates.
 *
 * Extends PlatformRepository because this collection defines the tenant
 * boundary rather than sitting inside one — an estate cannot be scoped to
 * itself. Every read of another estate's record still requires platform
 * permissions, checked in the service.
 */
export class EstateRepository extends PlatformRepository<EstateDoc> {
  constructor() {
    super(EstateModel);
  }

  findBySlug(slug: string): Promise<EstateDoc | null> {
    return this.findOne({ slug: slug.toLowerCase(), deletedAt: null });
  }
}

export const estateRepository = new EstateRepository();
