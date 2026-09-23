import { BaseRepository } from '@/core/db';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import {
  FeeCategoryModel,
  type BillingBasis,
  type BillingFrequency,
  type FeeCategoryDoc,
} from './schema';

class FeeCategoryRepository extends BaseRepository<FeeCategoryDoc> {
  constructor() {
    super(FeeCategoryModel);
  }
}

export const feeCategoryRepository = new FeeCategoryRepository();

export interface CreateFeeCategoryInput {
  code: string;
  name: string;
  description?: string;
  /** Integer minor units. */
  amount: number;
  currency?: string;
  frequency?: BillingFrequency;
  basis?: BillingBasis;
  dueDayOfMonth?: number;
  latePenaltyPercent?: number;
}

export class FeeCategoryService {
  async list(context: RequestContext, includeInactive = false): Promise<FeeCategoryDoc[]> {
    assertCan(context, PERMISSIONS.FEE_VIEW);

    return feeCategoryRepository.findMany(context, includeInactive ? {} : { active: true }, {
      sort: { name: 1 },
    });
  }

  async create(context: RequestContext, input: CreateFeeCategoryInput): Promise<FeeCategoryDoc> {
    assertCan(context, PERMISSIONS.FEE_CREATE);

    // Rejected here as well as by the schema so the caller gets a 422 naming the
    // problem rather than a driver error about a failed validator.
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new UnprocessableError('A fee amount must be a whole number of minor units.');
    }

    const code = input.code.trim().toLowerCase();

    if (await feeCategoryRepository.exists(context, { code })) {
      throw new ConflictError(`A fee with the code "${code}" already exists.`);
    }

    const category = await feeCategoryRepository.create(context, {
      code,
      name: input.name,
      description: input.description ?? null,
      amount: input.amount,
      currency: input.currency ?? 'NGN',
      frequency: input.frequency ?? 'monthly',
      basis: input.basis ?? 'property',
      dueDayOfMonth: input.dueDayOfMonth ?? 1,
      latePenaltyPercent: input.latePenaltyPercent ?? 0,
      active: true,
    });

    await auditService.record(context, {
      action: 'fee.created',
      resource: 'fee_category',
      resourceId: category._id.toHexString(),
      metadata: { code, amount: input.amount, frequency: category.frequency },
    });

    return category;
  }

  /**
   * Change a fee.
   *
   * Only future billing is affected. Invoices store their own line totals, so
   * raising a levy never restates what residents were already charged.
   */
  async update(
    context: RequestContext,
    id: string,
    changes: Partial<Omit<CreateFeeCategoryInput, 'code'>> & { active?: boolean },
  ): Promise<FeeCategoryDoc> {
    assertCan(context, PERMISSIONS.FEE_UPDATE);

    if (changes.amount !== undefined && (!Number.isInteger(changes.amount) || changes.amount < 0)) {
      throw new UnprocessableError('A fee amount must be a whole number of minor units.');
    }

    const before = await feeCategoryRepository.findByIdOrFail(context, id);
    const updated = await feeCategoryRepository.updateById(context, id, { $set: changes });

    await auditService.record(context, {
      action: 'fee.updated',
      resource: 'fee_category',
      resourceId: id,
      before: { amount: before.amount, active: before.active },
      after: { amount: updated.amount, active: updated.active },
    });

    return updated;
  }

  /**
   * Retire a fee.
   *
   * Soft delete, because issued invoices reference the category and a statement
   * that cannot name what it charged for is not a statement.
   */
  async retire(context: RequestContext, id: string): Promise<void> {
    assertCan(context, PERMISSIONS.FEE_DELETE);

    await feeCategoryRepository.softDelete(context, id);

    await auditService.record(context, {
      action: 'fee.retired',
      resource: 'fee_category',
      resourceId: id,
    });
  }
}

export const feeCategoryService = new FeeCategoryService();
