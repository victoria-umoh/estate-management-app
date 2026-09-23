import { createLogger } from '@/core/logging';
import { systemContext } from '@/core/tenancy';
import { EstateModel } from '@/modules/estate';
import { MembershipModel } from '@/modules/membership/schema';
import {
  feeCategoryRepository,
  invoiceService,
  type BillingFrequency,
  type FeeCategoryDoc,
} from '@/modules/finance';

const log = createLogger('job:billing');

export interface BillingRunResult {
  estates: number;
  categories: number;
  invoicesCreated: number;
  skipped: number;
}

/**
 * The period a fee covers on a given run date.
 *
 * The period is what makes the run safe to repeat: it is part of the unique
 * index on invoices, so a second run over the same month collides rather than
 * billing twice. A run that produced fresh periods each time would double-charge
 * every resident the moment someone retried a failed job.
 */
function periodFor(frequency: BillingFrequency, on: Date): { start: Date; end: Date } | null {
  const year = on.getUTCFullYear();
  const month = on.getUTCMonth();

  switch (frequency) {
    case 'monthly':
      return {
        start: new Date(Date.UTC(year, month, 1)),
        end: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
      };
    case 'quarterly': {
      const quarterStart = Math.floor(month / 3) * 3;
      return {
        start: new Date(Date.UTC(year, quarterStart, 1)),
        end: new Date(Date.UTC(year, quarterStart + 3, 0, 23, 59, 59, 999)),
      };
    }
    case 'yearly':
      return {
        start: new Date(Date.UTC(year, 0, 1)),
        end: new Date(Date.UTC(year, 12, 0, 23, 59, 59, 999)),
      };
    case 'one-time':
      // Charged deliberately, not on a schedule.
      return null;
  }
}

/** Only bill on the day the fee falls due, so a daily run is safe to leave on. */
function isDueToday(category: FeeCategoryDoc, on: Date): boolean {
  if (category.frequency === 'monthly') return on.getUTCDate() === category.dueDayOfMonth;

  const month = on.getUTCMonth();
  if (category.frequency === 'quarterly') {
    return month % 3 === 0 && on.getUTCDate() === category.dueDayOfMonth;
  }
  if (category.frequency === 'yearly') {
    return month === 0 && on.getUTCDate() === category.dueDayOfMonth;
  }

  return false;
}

/**
 * Generate invoices for every recurring fee that falls due.
 *
 * Invoices are created as drafts and issued individually, so a single failure —
 * one membership with bad data — costs one invoice rather than the whole run.
 * The unique period index absorbs retries.
 */
export async function runBilling(on = new Date(), force = false): Promise<BillingRunResult> {
  const estates = await EstateModel.find(
    { status: { $in: ['trial', 'active', 'past-due'] }, deletedAt: null },
    { _id: 1 },
  ).lean();

  const result: BillingRunResult = {
    estates: estates.length,
    categories: 0,
    invoicesCreated: 0,
    skipped: 0,
  };

  for (const estate of estates) {
    const context = systemContext(estate._id.toHexString(), 'billing-run');
    const categories = await feeCategoryRepository.findMany(context, { active: true });

    for (const category of categories) {
      if (!force && !isDueToday(category, on)) continue;

      const period = periodFor(category.frequency, on);
      if (!period) continue;

      result.categories += 1;

      // `property` bills each occupied unit once; `resident` bills each active
      // member. Either way the invoice hangs off a membership, because that is
      // who can be asked to pay.
      const memberships = await MembershipModel.find(
        {
          estateId: estate._id,
          status: 'active',
          deletedAt: null,
          ...(category.basis === 'property' ? { propertyId: { $ne: null } } : {}),
        },
        { _id: 1, propertyId: 1 },
      ).lean();

      const seenProperties = new Set<string>();

      for (const membership of memberships) {
        // One invoice per unit, not per person living in it.
        if (category.basis === 'property') {
          const key = membership.propertyId?.toHexString();
          if (!key || seenProperties.has(key)) continue;
          seenProperties.add(key);
        }

        try {
          const invoice = await invoiceService.create(context, {
            membershipId: membership._id.toHexString(),
            ...(membership.propertyId
              ? { propertyId: membership.propertyId.toHexString() }
              : {}),
            lines: [
              {
                feeCategoryId: category._id.toHexString(),
                description: category.name,
                unitAmount: category.amount,
              },
            ],
            dueAt: period.end,
            periodStart: period.start,
            periodEnd: period.end,
            currency: category.currency,
          });

          await invoiceService.issue(context, invoice._id.toHexString());
          result.invoicesCreated += 1;
        } catch (error) {
          // A duplicate-key error is the period index doing its job on a repeat
          // run, and is expected rather than a failure.
          if (error instanceof Error && /duplicate key|E11000/i.test(error.message)) {
            result.skipped += 1;
            continue;
          }

          result.skipped += 1;
          log.error(
            { err: error, membershipId: membership._id.toHexString(), code: category.code },
            'failed to bill a membership',
          );
        }
      }
    }
  }

  log.info(result, 'billing run complete');
  return result;
}

/**
 * Flag invoices that have gone past their due date, across every estate.
 *
 * Separate from the billing run because it wants to run daily while billing
 * runs monthly, and because status drift is cheap to fix but expensive to
 * notice late — an estate chasing arrears works from this flag.
 */
export async function runOverdueSweep(): Promise<{ estates: number; marked: number }> {
  const estates = await EstateModel.find(
    { status: { $in: ['trial', 'active', 'past-due'] }, deletedAt: null },
    { _id: 1 },
  ).lean();

  let marked = 0;

  for (const estate of estates) {
    marked += await invoiceService.markOverdue(
      systemContext(estate._id.toHexString(), 'overdue-sweep'),
    );
  }

  log.info({ estates: estates.length, marked }, 'overdue sweep complete');
  return { estates: estates.length, marked };
}
