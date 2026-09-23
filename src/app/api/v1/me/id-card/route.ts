import { z } from 'zod';
import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { credentialService } from '@/modules/credential';
import { residentService } from '@/modules/resident';

/**
 * The resident's own digital ID.
 *
 * Issues a credential on first request rather than at approval, so a resident
 * who never opens the app does not carry a live gate credential they have never
 * seen. The token is returned each time it is issued and only ever rendered as
 * a QR — it is not stored by the browser.
 */
export const POST = defineRoute({
  status: 200,
  body: z.object({ membershipId: z.string().min(1) }),
  rateLimit: { key: 'user', limit: 30, window: '1h', bucket: 'me:id-card' },
  handler: async (ctx, { body }) => {
    // Asserts the membership belongs to the caller. Staff issuing on someone's
    // behalf goes through the resident module, where it is audited as such.
    const identity = await residentService.ownIdentity(ctx, body.membershipId);

    const { token } = await credentialService.issue(ctx, {
      subject: 'resident',
      subjectId: body.membershipId,
      display: {
        primaryLabel: identity.fullName,
        secondaryLabel: null,
        unitNumber: identity.unitNumber,
        category: identity.category,
        photoUrl: identity.photoUrl,
      },
      // A year, after which the card must be refreshed. Bounded so a
      // screenshot taken today cannot open a gate indefinitely.
      ttlSeconds: 365 * 24 * 3600,
    });

    return {
      token,
      fullName: identity.fullName,
      category: identity.category,
      unitNumber: identity.unitNumber,
      residentCode: identity.residentCode,
      photoUrl: identity.photoUrl,
      status: identity.status,
    };
  },
});

export const GET = defineRoute({
  permissions: [PERMISSIONS.RESIDENT_VIEW],
  query: z.object({ membershipId: z.string().min(1) }),
  handler: async (ctx, { query }) => residentService.ownIdentity(ctx, query.membershipId),
});
