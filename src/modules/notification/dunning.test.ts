/**
 * Dunning actually tells somebody.
 *
 * Both halves of the ladder had been running silently: estates slid into
 * read-only grace and invoices were flagged overdue, and in neither case did
 * the person who could do something about it hear a word. These tests assert
 * that the message is produced, addressed to the right person, and carries the
 * numbers they need — not merely that the sweep returned a count.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { events } from '@/core/events';
import { blindIndex } from '@/core/crypto';
import type { RequestContext } from '@/core/tenancy';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  setEmailProvider,
  setSmsProvider,
} from '@/integrations/notifications';
import { InlineJobQueue, setQueue } from '@/integrations/queue';
import { EstateModel } from '@/modules/estate';
import { invoiceService } from '@/modules/finance';
import { MembershipModel } from '@/modules/membership/schema';
import { PropertyModel } from '@/modules/property';
import { RoleModel } from '@/modules/role';
import { subscriptionService } from '@/modules/subscription/service';
import { UserModel } from '@/modules/user/schema';
import { registerNotificationHandlers, unregisterNotificationHandlers } from './handlers';
import { registerNotificationJobs, resetNotificationJobs } from './jobs';
import { NotificationModel } from './schema';

setupTestDatabase();

const ESTATE = new mongoose.Types.ObjectId();

let email: ConsoleEmailProvider;

beforeEach(async () => {
  setCache(new MemoryCacheAdapter());

  email = new ConsoleEmailProvider();
  setEmailProvider(email);
  setSmsProvider(new ConsoleSmsProvider());

  resetNotificationJobs();
  setQueue(new InlineJobQueue());
  await registerNotificationJobs();

  unregisterNotificationHandlers();
  registerNotificationHandlers();

  await MembershipModel.syncIndexes();
});

afterEach(() => {
  unregisterNotificationHandlers();
  events.removeAllHandlers();
  setCache(undefined);
  setEmailProvider(undefined);
  setSmsProvider(undefined);
  setQueue(undefined);
  resetNotificationJobs();
});

function ctx(): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId: ESTATE.toHexString(),
    roles: ['finance-admin'],
    permissions: new Set(['*']),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

/** A resident of the estate, with an inbox we can inspect. */
async function member(
  address: string,
  options: { roleIds?: mongoose.Types.ObjectId[] } = {},
): Promise<mongoose.Types.ObjectId> {
  const phone = `+23480${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  const user = await UserModel.create({
    firstName: 'Ada',
    lastName: 'Okonkwo',
    email: address,
    phone,
    emailIndex: blindIndex(address, 'email'),
    phoneIndex: blindIndex(phone, 'phone'),
    passwordHash: 'x',
    status: 'active',
    twoFactorEnabled: false,
    failedLoginAttempts: 0,
    isPlatformAdmin: false,
  });

  const membership = await MembershipModel.create({
    estateId: ESTATE,
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: options.roleIds ?? [],
  });

  return membership._id;
}

// -----------------------------------------------------------------------------

describe('an estate falling past due', () => {
  async function chairman(): Promise<mongoose.Types.ObjectId> {
    const role = await RoleModel.create({
      estateId: ESTATE,
      code: 'estate-chairman',
      name: 'Estate Chairman',
      isSystem: true,
      rank: 90,
    });

    return member('chairman@example.com', { roleIds: [role._id] });
  }

  async function lapsedEstate(): Promise<void> {
    await EstateModel.create({
      _id: ESTATE,
      name: 'Palm Grove Estate',
      slug: 'palm-grove-estate',
      address: { line1: '1 Acacia Close', city: 'Lekki', state: 'Lagos' },
      contact: { email: 'office@example.com', phone: '+2348011112222' },
      status: 'active',
      planCode: 'starter',
      billingPeriod: 'monthly',
      // Six days ago: inside the grace window, so this run moves it to past-due
      // and no further.
      subscriptionEndsAt: new Date(Date.now() - 6 * 86_400_000),
    });

    await PropertyModel.create({
      estateId: ESTATE,
      unitNumber: '1A',
      street: 'Acacia Close',
      type: 'duplex',
      occupancyStatus: 'vacant',
      currentOccupantCount: 0,
    });
  }

  it('emails the chairman', async () => {
    const chairmanMembership = await chairman();
    await lapsedEstate();

    await subscriptionService.runDunning();
    // The bus is fire-and-forget, so give the handler a turn to finish.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const sent = email.sent.at(-1);
    expect(sent?.to).toBe('chairman@example.com');
    expect(sent?.subject).toMatch(/is \d+ days overdue/);
    expect(sent?.text).toContain('SUBSCRIPTION-');

    const inApp = await NotificationModel.findOne({
      recipientMembershipId: chairmanMembership,
    }).lean();
    expect(inApp?.templateId).toBe('billing.payment-overdue');
  });

  it('says how many days it has been', async () => {
    await chairman();
    await lapsedEstate();

    await subscriptionService.runDunning();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(email.sent.at(-1)?.subject).toContain('6 days overdue');
  });

  it('does not notify an ordinary resident', async () => {
    await chairman();
    await member('resident@example.com');
    await lapsedEstate();

    await subscriptionService.runDunning();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(email.sent.map((sent) => sent.to)).not.toContain('resident@example.com');
  });

  it('still moves the estate when there is nobody to tell', async () => {
    await lapsedEstate();

    const result = await subscriptionService.runDunning();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The notification is a consequence of the state change, never a condition
    // of it: an estate with no chairman on file must still go read-only.
    expect(result.toGrace).toBe(1);
    expect((await EstateModel.findById(ESTATE).lean())!.status).toBe('past-due');
    expect(email.sent).toHaveLength(0);
  });
});

describe('an invoice falling overdue', () => {
  async function overdueInvoice(membershipId: mongoose.Types.ObjectId) {
    const invoice = await invoiceService.create(ctx(), {
      membershipId: membershipId.toHexString(),
      lines: [{ description: 'Monthly estate dues', unitAmount: 5_000_000 }],
      dueAt: new Date(Date.now() + 86_400_000),
    });

    const issued = await invoiceService.issue(ctx(), invoice._id.toHexString());

    // Backdated after issue, because issuing an already-overdue invoice is a
    // different (and invalid) thing to test.
    await mongoose.connection
      .collection('invoices')
      .updateOne({ _id: issued._id }, { $set: { dueAt: new Date(Date.now() - 3 * 86_400_000) } });

    return issued;
  }

  it('emails the resident who owes it', async () => {
    const membershipId = await member('debtor@example.com');
    const invoice = await overdueInvoice(membershipId);
    email.clear();

    expect(await invoiceService.markOverdue(ctx())).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const sent = email.sent.at(-1);
    expect(sent?.to).toBe('debtor@example.com');
    expect(sent?.subject).toContain(invoice.number);
    expect(sent?.subject).toContain('3 days overdue');
    expect(sent?.text).toContain('50,000.00');
  });

  it('records it in-app as well, so it survives a failed email', async () => {
    const membershipId = await member('debtor@example.com');
    await overdueInvoice(membershipId);

    await invoiceService.markOverdue(ctx());
    await new Promise((resolve) => setTimeout(resolve, 200));

    const inApp = await NotificationModel.findOne({
      recipientMembershipId: membershipId,
      templateId: 'billing.payment-overdue',
    }).lean();

    expect(inApp).not.toBeNull();
  });

  it('says nothing on a second sweep, because there is nothing new to say', async () => {
    const membershipId = await member('debtor@example.com');
    await overdueInvoice(membershipId);

    await invoiceService.markOverdue(ctx());
    await new Promise((resolve) => setTimeout(resolve, 200));
    email.clear();

    expect(await invoiceService.markOverdue(ctx())).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(email.sent).toHaveLength(0);
  });
});
