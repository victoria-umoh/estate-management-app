import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { TransferOwnershipDto, propertyService } from '@/modules/property';

/**
 * Transfer ownership.
 *
 * Idempotent: a retried transfer after a timeout must not create a second
 * ownership record and a second audit entry.
 */
export const POST = defineRoute({
  permissions: [PERMISSIONS.PROPERTY_TRANSFER],
  params: z.object({ id: z.string() }),
  body: TransferOwnershipDto,
  idempotent: true,
  status: 200,
  rateLimit: { key: 'user', limit: 20, window: '1h', bucket: 'property:transfer' },
  handler: async (ctx, { params, body }) => {
    await propertyService.transferOwnership(ctx, { propertyId: params.id, ...body });
    return { transferred: true };
  },
});
