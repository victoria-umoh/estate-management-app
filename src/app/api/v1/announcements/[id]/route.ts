import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { announcementService } from '@/modules/announcement';
import { serializeAnnouncement } from '../route';

const Params = z.object({ id: z.string() });

const RESIDENT_CATEGORIES = [
  'homeowner',
  'landlord',
  'tenant',
  'dependant',
  'family-member',
  'domestic-staff',
  'estate-staff',
  'security-personnel',
  'contractor',
  'other',
] as const;

export const GET = defineRoute({
  permissions: [PERMISSIONS.ANNOUNCEMENT_VIEW],
  params: Params,
  handler: async (ctx, { params }) =>
    serializeAnnouncement(await announcementService.get(ctx, params.id)),
});

/**
 * Edit.
 *
 * Once published, only pinning and expiry remain editable — the service rejects
 * anything that would rewrite what residents were already told.
 */
export const PATCH = defineRoute({
  permissions: [PERMISSIONS.ANNOUNCEMENT_UPDATE],
  params: Params,
  body: z.object({
    title: z.string().min(1).max(160).optional(),
    body: z.string().min(1).max(20_000).optional(),
    summary: z.string().max(280).optional(),
    audience: z
      .object({
        type: z.enum(['all', 'categories']),
        categories: z.array(z.enum(RESIDENT_CATEGORIES)).optional(),
      })
      .optional(),
    pinned: z.boolean().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  }),
  status: 200,
  handler: async (ctx, { params, body }) =>
    serializeAnnouncement(await announcementService.update(ctx, params.id, body)),
});

/** Take it down. Archived rather than erased, so the audit trail still resolves. */
export const DELETE = defineRoute({
  permissions: [PERMISSIONS.ANNOUNCEMENT_DELETE],
  params: Params,
  status: 200,
  handler: async (ctx, { params }) => {
    await announcementService.archive(ctx, params.id);
    return { id: params.id, status: 'archived' as const };
  },
});
