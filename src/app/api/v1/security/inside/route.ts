import { defineRoute } from '@/core/http';
import { PERMISSIONS } from '@/core/rbac';
import { visitorPassRepository } from '@/modules/visitor';

/**
 * Who is currently in the estate.
 *
 * The security dashboard's headline. Read from the passes' own state rather
 * than replayed from the movement log, which would mean scanning every event of
 * the day on every refresh.
 */
export const GET = defineRoute({
  permissions: [PERMISSIONS.GATE_LOG_VIEW],
  handler: async (ctx) => {
    const inside = await visitorPassRepository.findCurrentlyInside(ctx);
    const now = Date.now();

    return inside.map((pass) => {
      const minutesOver = Math.floor((now - pass.expectedDeparture.getTime()) / 60_000);

      return {
        id: pass._id.toHexString(),
        code: pass.code,
        visitorName: pass.visitorName,
        partySize: pass.partySize,
        purpose: pass.purpose,
        vehiclePlate: pass.vehiclePlate,
        checkedInAt: pass.checkedInAt,
        expectedDeparture: pass.expectedDeparture,
        overstaying: minutesOver > 0,
        minutesOver: minutesOver > 0 ? minutesOver : 0,
      };
    });
  },
});
