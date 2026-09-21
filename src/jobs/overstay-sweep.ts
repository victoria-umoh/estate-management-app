import { createLogger } from '@/core/logging';
import { EstateModel } from '@/modules/estate';
import { visitorService } from '@/modules/visitor';

const log = createLogger('job:overstay');

/**
 * Flag visitors who are still inside past their departure time.
 *
 * Runs across every estate, honouring each one's own grace period — an estate
 * that sets 15 minutes and one that sets three hours are both served by this
 * single pass.
 *
 * Each pass is raised once. Without `overstayNotifiedAt`, a sweep every five
 * minutes would message the host every five minutes, and a host who is being
 * pestered stops reading the alerts entirely — which costs more than the
 * overstay did.
 */
export interface OverstaySweepResult {
  scanned: number;
  flagged: number;
  estates: number;
}

export async function runOverstaySweep(): Promise<OverstaySweepResult> {
  const estates = await EstateModel.find(
    { status: { $in: ['trial', 'active', 'past-due'] }, deletedAt: null },
    { _id: 1, 'settings.visitorOverstayGraceMinutes': 1 },
  ).lean();

  if (estates.length === 0) return { scanned: 0, flagged: 0, estates: 0 };

  const graceByEstate = new Map(
    estates.map((estate) => [
      estate._id.toHexString(),
      estate.settings?.visitorOverstayGraceMinutes ?? 60,
    ]),
  );

  const overstaying = await visitorService.findOverstaying(graceByEstate);

  let flagged = 0;
  for (const pass of overstaying) {
    try {
      await visitorService.markOverstayNotified(pass);
      flagged += 1;
    } catch (error) {
      // One bad record must not stop the sweep: the remaining overstays are
      // exactly the ones somebody needs to hear about.
      log.error(
        { err: error, passId: pass._id.toHexString() },
        'failed to flag overstaying visitor',
      );
    }
  }

  log.info({ estates: estates.length, flagged }, 'overstay sweep complete');

  return { scanned: overstaying.length, flagged, estates: estates.length };
}
