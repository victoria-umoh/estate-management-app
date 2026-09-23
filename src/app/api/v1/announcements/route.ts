import { z } from 'zod';
import { defineRoute, paginated } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { announcementService } from '@/modules/announcement';

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

function serialize(announcement: Awaited<ReturnType<typeof announcementService.get>>) {
  return {
    id: announcement._id.toHexString(),
    title: announcement.title,
    summary: announcement.summary,
    body: announcement.body,
    status: announcement.status,
    audience: {
      type: announcement.audience.type,
      categories: announcement.audience.categories,
    },
    pinned: announcement.pinned,
    expiresAt: announcement.expiresAt ?? null,
    publishedAt: announcement.publishedAt ?? null,
    notifiedCount: announcement.notifiedCount,
    createdAt: announcement.createdAt,
    updatedAt: announcement.updatedAt,
  };
}

export { serialize as serializeAnnouncement };

/**
 * List announcements.
 *
 * The service decides what the caller may see: authors get drafts, residents
 * get only what is published and unexpired.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.ANNOUNCEMENT_VIEW],
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
    status: z.enum(['draft', 'published', 'archived']).optional(),
  }),
  handler: async (ctx, { query }) => {
    const result = await announcementService.list(ctx, query);
    return paginated({ ...result, items: result.items.map(serialize) });
  },
});

/** Create a draft. Publishing is a separate call behind a separate permission. */
export const POST = defineRoute({
  permissions: [PERMISSIONS.ANNOUNCEMENT_CREATE],
  body: z.object({
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(20_000),
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
  handler: async (ctx, { body }) => serialize(await announcementService.create(ctx, body)),
});
