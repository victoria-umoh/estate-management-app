/**
 * Notifications.
 *
 * The properties under test are the ones where being wrong is not merely
 * annoying: a muted resident must still be told about an emergency, one estate
 * must not be able to read or clear another's alerts, and a dead SMS gateway
 * must not take down the payment that triggered the message.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { events } from '@/core/events';
import type { RequestContext } from '@/core/tenancy';
import {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  setEmailProvider,
  setSmsProvider,
  type DeliveryResult,
  type EmailProvider,
} from '@/integrations/notifications';
import { InlineJobQueue, setQueue } from '@/integrations/queue';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { registerNotificationJobs, resetNotificationJobs } from './jobs';
import { NotificationModel, NotificationPreferenceModel } from './schema';
import { notificationService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

let email: ConsoleEmailProvider;
let sms: ConsoleSmsProvider;

beforeEach(async () => {
  email = new ConsoleEmailProvider();
  sms = new ConsoleSmsProvider();
  setEmailProvider(email);
  setSmsProvider(sms);

  // Inline so an enqueued message is delivered before the assertion runs; the
  // real queue is BullMQ and is exercised in its own suite.
  resetNotificationJobs();
  setQueue(new InlineJobQueue());
  await registerNotificationJobs();

  await NotificationPreferenceModel.syncIndexes();
});

afterEach(() => {
  setEmailProvider(undefined);
  setSmsProvider(undefined);
  setQueue(undefined);
  resetNotificationJobs();
  events.removeAllHandlers();
});

let sequence = 0;

/** A user and their membership of one estate, as the service expects to find them. */
async function resident(estateId: string) {
  sequence += 1;
  const emailAddress = `resident${sequence}@example.com`;
  const phone = `+23480000000${String(sequence).padStart(2, '0')}`;

  const user = await UserModel.create({
    firstName: 'Ada',
    lastName: `Resident${sequence}`,
    email: emailAddress,
    phone,
    emailIndex: blindIndex(emailAddress, 'email'),
    phoneIndex: blindIndex(phone, 'phone'),
    passwordHash: 'not-a-real-hash',
    status: 'active',
  });

  const membership = await MembershipModel.create({
    estateId: new mongoose.Types.ObjectId(estateId),
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });

  return {
    userId: user._id.toHexString(),
    membershipId: membership._id.toHexString(),
    email: emailAddress,
    phone,
  };
}

function ctx(estateId: string, userId: string, permissions: string[] = ['*']): RequestContext {
  return {
    userId,
    estateId,
    roles: ['resident'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

describe('channel preferences', () => {
  it('applies the defaults when a resident has never set any', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    const preferences = await notificationService.preferencesForCaller(context);

    // Billing reaches for SMS because an unpaid levy has consequences; a
    // visitor notification does not.
    expect(preferences.billing).toEqual({ inApp: true, email: true, sms: true });
    expect(preferences.visitor).toEqual({ inApp: true, email: false, sms: false });
  });

  it('honours a resident who has switched a category off', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    await notificationService.updatePreferencesForCaller(context, {
      billing: { email: false, sms: false },
    });

    const resolved = await notificationService.resolveChannels(
      context,
      who.membershipId,
      'billing',
    );

    expect(resolved).toMatchObject({ email: false, sms: false, mandatory: false });

    await notificationService.send(context, {
      recipientMembershipId: who.membershipId,
      templateId: 'billing.invoice-issued',
      data: {
        invoiceNumber: 'INV-0001',
        amount: '50,000.00',
        currency: 'NGN',
        dueDate: '2026-10-01',
      },
    });

    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);

    // In-app is never switched off: it is the record, and a resident who muted
    // billing must still be able to discover that they owe money.
    expect(await NotificationModel.countDocuments()).toBe(1);
  });

  it('never switches the in-app record off, whatever is requested', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    const stored = await notificationService.updatePreferencesForCaller(context, {
      announcement: { email: false, sms: false },
    });

    expect(stored.announcement.inApp).toBe(true);
  });
});

describe('notifications that cannot be silenced', () => {
  // The whole point of the mandatory categories. Someone who muted "alerts" six
  // months ago must still be told their gate has reported an emergency.
  it('sends an emergency on every channel even when the resident muted everything', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    // Written straight to the collection, bypassing the service, to prove the
    // rule holds against data the service would never have produced — which is
    // exactly what an older client or a direct database edit could leave behind.
    await NotificationPreferenceModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      membershipId: new mongoose.Types.ObjectId(who.membershipId),
      categories: {
        emergency: { inApp: false, email: false, sms: false },
        security: { inApp: false, email: false, sms: false },
        visitor: { inApp: false, email: false, sms: false },
        billing: { inApp: false, email: false, sms: false },
        announcement: { inApp: false, email: false, sms: false },
        maintenance: { inApp: false, email: false, sms: false },
        account: { inApp: false, email: false, sms: false },
      },
    });

    const resolved = await notificationService.resolveChannels(
      context,
      who.membershipId,
      'emergency',
    );
    expect(resolved).toEqual({ inApp: true, email: true, sms: true, mandatory: true });

    const record = await notificationService.send(context, {
      recipientMembershipId: who.membershipId,
      templateId: 'emergency.triggered',
      data: {
        reference: 'EMG-2026-00001',
        type: 'fire',
        location: 'Block C',
        reportedBy: 'PGE-2026-00012',
      },
    });

    expect(record?.dispatchedChannels).toEqual(['in-app', 'email', 'sms']);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    // Front-loaded, because on a locked handset only the first line shows.
    expect(sms.sent[0]!.body).toMatch(/^EMERGENCY fire at Block C/);
  });

  it('refuses to store a mute for a mandatory category', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    // Accepted rather than rejected — an old client may still render the toggle
    // — but what comes back, and what is stored, is the unmuted truth.
    const stored = await notificationService.updatePreferencesForCaller(context, {
      emergency: { email: false, sms: false },
      security: { email: false, sms: false },
    });

    expect(stored.emergency).toEqual({ inApp: true, email: true, sms: true });
    expect(stored.security).toEqual({ inApp: true, email: true, sms: true });

    const resolved = await notificationService.resolveChannels(
      context,
      who.membershipId,
      'security',
    );
    expect(resolved.mandatory).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('does not show one estate the notifications of another', async () => {
    const inA = await resident(ESTATE_A);
    const inB = await resident(ESTATE_B);

    await notificationService.send(ctx(ESTATE_A, inA.userId), {
      recipientMembershipId: inA.membershipId,
      templateId: 'account.approved',
      data: { name: 'Ada', estateName: 'Palm Grove', residentCode: 'PGE-1' },
    });

    const theirs = await notificationService.listForCaller(ctx(ESTATE_B, inB.userId));
    expect(theirs.items).toHaveLength(0);

    const ours = await notificationService.listForCaller(ctx(ESTATE_A, inA.userId));
    expect(ours.items).toHaveLength(1);
  });

  it('will not let another estate mark a notification read', async () => {
    const inA = await resident(ESTATE_A);
    const inB = await resident(ESTATE_B);

    const record = await notificationService.send(ctx(ESTATE_A, inA.userId), {
      recipientMembershipId: inA.membershipId,
      templateId: 'account.approved',
      data: { name: 'Ada', estateName: 'Palm Grove', residentCode: 'PGE-1' },
    });

    await expect(
      notificationService.markRead(ctx(ESTATE_B, inB.userId), record!._id.toHexString()),
    ).rejects.toThrow(/not found/i);

    const reloaded = await NotificationModel.findById(record!._id).lean();
    expect(reloaded?.readAt ?? null).toBeNull();
  });

  it('will not let one resident mark another resident notification read', async () => {
    const owner = await resident(ESTATE_A);
    const neighbour = await resident(ESTATE_A);

    const record = await notificationService.send(ctx(ESTATE_A, owner.userId), {
      recipientMembershipId: owner.membershipId,
      templateId: 'account.approved',
      data: { name: 'Ada', estateName: 'Palm Grove', residentCode: 'PGE-1' },
    });

    await expect(
      notificationService.markRead(ctx(ESTATE_A, neighbour.userId), record!._id.toHexString()),
    ).rejects.toThrow(/not found/i);
  });
});

describe('reading', () => {
  it('marks one read, and then all', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    for (let i = 0; i < 3; i += 1) {
      await notificationService.send(context, {
        recipientMembershipId: who.membershipId,
        templateId: 'account.approved',
        data: { name: 'Ada', estateName: 'Palm Grove', residentCode: `PGE-${i}` },
      });
    }

    expect(await notificationService.unreadCountForCaller(context)).toBe(3);

    const [first] = (await notificationService.listForCaller(context)).items;
    await notificationService.markRead(context, first!._id.toHexString());
    expect(await notificationService.unreadCountForCaller(context)).toBe(2);

    expect(await notificationService.markAllRead(context)).toBe(2);
    expect(await notificationService.unreadCountForCaller(context)).toBe(0);
  });

  it('filters to unread on request', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    await notificationService.send(context, {
      recipientMembershipId: who.membershipId,
      templateId: 'account.approved',
      data: { name: 'Ada', estateName: 'Palm Grove', residentCode: 'PGE-1' },
    });
    await notificationService.markAllRead(context);

    const unread = await notificationService.listForCaller(context, { unreadOnly: true });
    expect(unread.items).toHaveLength(0);
  });
});

describe('failure containment', () => {
  /** A provider that is down in the least convenient way: it throws. */
  class BrokenEmailProvider implements EmailProvider {
    readonly name = 'broken';
    async send(): Promise<DeliveryResult> {
      throw new Error('connect ECONNREFUSED');
    }
  }

  it('does not throw into the caller when the provider fails', async () => {
    setEmailProvider(new BrokenEmailProvider());

    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    // The thing that matters: this resolves. A settled payment must not be
    // rolled back because a mail server was unreachable.
    const record = await notificationService.send(context, {
      recipientMembershipId: who.membershipId,
      templateId: 'billing.payment-received',
      data: {
        invoiceNumber: 'INV-0001',
        amount: '50,000.00',
        currency: 'NGN',
        reference: 'PAY-1',
      },
    });

    expect(record).not.toBeNull();
    // And the durable copy still exists, so the resident finds out anyway.
    expect(await NotificationModel.countDocuments()).toBe(1);
  });

  it('does not throw when the recipient membership no longer exists', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);
    const ghost = new mongoose.Types.ObjectId().toHexString();

    await expect(
      notificationService.send(context, {
        recipientMembershipId: ghost,
        templateId: 'account.approved',
        data: { name: 'Ada', estateName: 'Palm Grove', residentCode: 'PGE-1' },
      }),
    ).resolves.not.toThrow();

    expect(who.membershipId).toBeTruthy();
  });
});

describe('templates', () => {
  it('requires the template-manage permission to list them', async () => {
    const who = await resident(ESTATE_A);

    expect(() => notificationService.listTemplates(ctx(ESTATE_A, who.userId, []))).toThrow(
      /notification.templateManage/,
    );

    const templates = notificationService.listTemplates(ctx(ESTATE_A, who.userId));
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.find((t) => t.id === 'emergency.triggered')?.silenceable).toBe(false);
    expect(templates.find((t) => t.id === 'billing.invoice-issued')?.silenceable).toBe(true);
  });

  it('renders the stored body at send time, not at read time', async () => {
    const who = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, who.userId);

    const record = await notificationService.send(context, {
      recipientMembershipId: who.membershipId,
      templateId: 'visitor.overstayed',
      data: { visitorName: 'Chidi', minutesOver: 45, passCode: 'VP-99' },
    });

    expect(record?.body).toContain('Chidi');
    expect(record?.body).toContain('45 minutes');
  });
});
