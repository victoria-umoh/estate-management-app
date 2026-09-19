import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { estateService } from '@/modules/estate';

export const GET = defineRoute({
  permissions: [PERMISSIONS.ESTATE_VIEW],
  handler: async (ctx) => {
    const estate = await estateService.getCurrent(ctx);

    return {
      id: estate._id.toHexString(),
      name: estate.name,
      slug: estate.slug,
      address: estate.address,
      contact: estate.contact,
      logoUrl: estate.logoUrl,
      status: estate.status,
      settings: estate.settings,
      stats: estate.stats,
    };
  },
});

const UpdateSettingsDto = z.object({
  visitorOverstayGraceMinutes: z.number().int().min(0).max(1440).optional(),
  visitorPassMaxDurationDays: z.number().int().min(1).max(90).optional(),
  requireResidentApproval: z.boolean().optional(),
  requireNinVerification: z.boolean().optional(),
  requireExitPassApproval: z.boolean().optional(),
  allowLandlordTenantRegistration: z.boolean().optional(),
  idCardExpiryWarningDays: z.number().int().min(1).max(365).optional(),
  timezone: z.string().max(64).optional(),
});

export const PATCH = defineRoute({
  permissions: [PERMISSIONS.ESTATE_SETTINGS_MANAGE],
  body: UpdateSettingsDto,
  status: 200,
  handler: async (ctx, { body }) => {
    const estate = await estateService.updateSettings(ctx, body);
    return { settings: estate.settings };
  },
});
