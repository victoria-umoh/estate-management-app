import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { temporaryPassRepository } from '@/modules/temporary-pass';

/** A pass in another estate is a 404 — the tenant filter simply does not find it. */
export const GET = defineRoute({
  permissions: [PERMISSIONS.TEMPORARY_PASS_VERIFY],
  params: z.object({ id: z.string() }),
  handler: async (ctx, { params }) => {
    const pass = await temporaryPassRepository.findByIdOrFail(ctx, params.id);

    return {
      id: pass._id.toHexString(),
      code: pass.code,
      holderName: pass.holderName,
      holderPhone: pass.holderPhone ?? null,
      company: pass.company ?? null,
      purpose: pass.purpose,
      sponsorMembershipId: pass.sponsorMembershipId.toHexString(),
      propertyId: pass.propertyId?.toHexString() ?? null,
      vehiclePlate: pass.vehiclePlate ?? null,
      status: pass.status,
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      useCount: pass.useCount,
      inside: pass.inside,
      lastUsedAt: pass.lastUsedAt ?? null,
      lastGateId: pass.lastGateId?.toHexString() ?? null,
      revokedAt: pass.revokedAt ?? null,
      revokedReason: pass.revokedReason ?? null,
      notes: pass.notes ?? null,
      createdAt: pass.createdAt,
      updatedAt: pass.updatedAt,
    };
  },
});
