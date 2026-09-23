import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { NotFoundError } from '@/core/errors';
import { PERMISSIONS, can } from '@/core/rbac';
import { exitPassRepository } from '@/modules/exit-pass';
import { meService } from '@/modules/me';

const Params = z.object({ id: z.string() });

/**
 * One exit pass, with its full manifest.
 *
 * A pass belonging to another household is a 404 rather than a 403 for anyone
 * who cannot approve — and a pass in another estate is already a 404 from the
 * repository, since the tenant filter simply does not find it.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.EXIT_PASS_VIEW],
  params: Params,
  handler: async (ctx, { params }) => {
    const pass = await exitPassRepository.findByIdOrFail(ctx, params.id);

    if (!can(ctx, PERMISSIONS.EXIT_PASS_APPROVE) && !can(ctx, PERMISSIONS.EXIT_PASS_VERIFY)) {
      const callerMembershipId = await meService.membershipId(ctx);
      if (pass.requestedByMembershipId.toHexString() !== callerMembershipId) {
        throw new NotFoundError('Exit pass');
      }
    }

    return {
      id: pass._id.toHexString(),
      code: pass.code,
      requestedByMembershipId: pass.requestedByMembershipId.toHexString(),
      propertyId: pass.propertyId?.toHexString() ?? null,
      carrierName: pass.carrierName,
      carrierPhone: pass.carrierPhone ?? null,
      destination: pass.destination,
      reason: pass.reason,
      vehiclePlate: pass.vehiclePlate ?? null,
      items: pass.items,
      status: pass.status,
      approvalRequired: pass.approvalRequired,
      approvedAt: pass.approvedAt ?? null,
      decisionReason: pass.decisionReason ?? null,
      // Surfaced so a client can grey out the manifest editor for the same
      // reason the service refuses the write.
      manifestLockedAt: pass.manifestLockedAt ?? null,
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      usedAt: pass.usedAt ?? null,
      usedGateId: pass.usedGateId?.toHexString() ?? null,
      notes: pass.notes ?? null,
      createdAt: pass.createdAt,
      updatedAt: pass.updatedAt,
    };
  },
});
