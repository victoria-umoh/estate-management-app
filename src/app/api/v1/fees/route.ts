import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { feeCategoryService } from '@/modules/finance';

export const GET = defineRoute({
  permissions: [PERMISSIONS.FEE_VIEW],
  query: z.object({
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  }),
  handler: async (ctx, { query }) => {
    const categories = await feeCategoryService.list(ctx, query.includeInactive);

    return categories.map((category) => ({
      id: category._id.toHexString(),
      code: category.code,
      name: category.name,
      description: category.description ?? null,
      amount: category.amount,
      currency: category.currency,
      frequency: category.frequency,
      basis: category.basis,
      dueDayOfMonth: category.dueDayOfMonth,
      latePenaltyPercent: category.latePenaltyPercent,
      active: category.active,
    }));
  },
});

export const POST = defineRoute({
  permissions: [PERMISSIONS.FEE_CREATE],
  body: z.object({
    code: z.string().trim().min(2).max(40),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(400).optional(),
    // Minor units, so an estate charging ₦50,000 sends 5000000.
    amount: z.number().int().nonnegative(),
    currency: z.string().trim().length(3).optional(),
    frequency: z.enum(['monthly', 'quarterly', 'yearly', 'one-time']).optional(),
    basis: z.enum(['property', 'resident']).optional(),
    dueDayOfMonth: z.number().int().min(1).max(28).optional(),
    latePenaltyPercent: z.number().min(0).max(100).optional(),
  }),
  handler: async (ctx, { body }) => {
    const category = await feeCategoryService.create(ctx, body);

    return {
      id: category._id.toHexString(),
      code: category.code,
      name: category.name,
      amount: category.amount,
    };
  },
});
