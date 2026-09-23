/**
 * Announcements.
 *
 * The properties under test are the ones that decide who hears what: a draft is
 * invisible until it is published, publishing reaches exactly the targeted
 * audience and nobody else, and one estate's notice never lands in another
 * estate's feed.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { events } from '@/core/events';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  setEmailProvider,
  setSmsProvider,
} from '@/integrations/notifications';
import { InlineJobQueue, setQueue } from '@/integrations/queue';
import { MembershipModel, type ResidentCategory } from '@/modules/membership/schema';
import { NotificationModel } from '@/modules/notification';
import { registerNotificationJobs, resetNotificationJobs } from '@/modules/notification';
import { UserModel } from '@/modules/user/schema';
import { AnnouncementModel } from './schema';
import { announcementService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

let email: ConsoleEmailProvider;

beforeEach(async () => {
  email = new ConsoleEmailProvider();
  setEmailProvider(email);
  setSmsProvider(new ConsoleSmsProvider());

  resetNotificationJobs();
  setQueue(new InlineJobQueue());
  await registerNotificationJobs();

  await AnnouncementModel.syncIndexes();
});

afterEach(() => {
  setEmailProvider(undefined);
  setSmsProvider(undefined);
  setQueue(undefined);
  resetNotificationJobs();
  events.removeAllHandlers();
});

let sequence = 0;

async function resident(
  estateId: string,
  category: ResidentCategory = 'homeowner',
  status: 'active' | 'suspended' = 'active',
) {
  sequence += 1;
  const emailAddress = `member${sequence}@example.com`;
  const phone = `+23481000000${String(sequence).padStart(2, '0')}`;

  const user = await UserModel.create({
    firstName: 'Ngozi',
    lastName: `Member${sequence}`,
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
    category,
    status,
    roleIds: [],
  });

  return { userId: user._id.toHexString(), membershipId: membership._id.toHexString() };
}

function ctx(estateId: string, userId: string, permissions: string[] = ['*']): RequestContext {
  return {
    userId,
    estateId,
    roles: ['estate-manager'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

async function draft(context: RequestContext, overrides: Record<string, unknown> = {}) {
  return announcementService.create(context, {
    title: 'Water supply interruption',
    body: 'The borehole pump is being replaced on Saturday. Water will be off from 8am to 2pm.',
    ...overrides,
  });
}

describe('drafting', () => {
  it('creates as a draft, never as published', async () => {
    const author = await resident(ESTATE_A);
    const created = await draft(ctx(ESTATE_A, author.userId));

    expect(created.status).toBe('draft');
    expect(created.publishedAt ?? null).toBeNull();
    // Writing an announcement and sending it to an entire estate are never the
    // same keystroke.
    expect(await NotificationModel.countDocuments()).toBe(0);
  });

  it('derives a summary from the body when none is given', async () => {
    const author = await resident(ESTATE_A);
    const created = await draft(ctx(ESTATE_A, author.userId));

    expect(created.summary).toBe('The borehole pump is being replaced on Saturday.');
  });

  it('refuses a category audience with no categories', async () => {
    const author = await resident(ESTATE_A);

    await expect(
      draft(ctx(ESTATE_A, author.userId), { audience: { type: 'categories', categories: [] } }),
    ).rejects.toThrow(/at least one resident category/i);
  });

  it('hides a draft from residents', async () => {
    const author = await resident(ESTATE_A);
    const reader = await resident(ESTATE_A);

    const created = await draft(ctx(ESTATE_A, author.userId));

    const residentContext = ctx(ESTATE_A, reader.userId, [PERMISSIONS.ANNOUNCEMENT_VIEW]);

    const list = await announcementService.list(residentContext);
    expect(list.items).toHaveLength(0);

    // 404, not 403: confirming that an unpublished announcement exists is
    // itself the leak.
    await expect(
      announcementService.get(residentContext, created._id.toHexString()),
    ).rejects.toThrow(/not found/i);
  });
});

describe('publishing', () => {
  it('fans out to every active member when the audience is everyone', async () => {
    const author = await resident(ESTATE_A);
    await resident(ESTATE_A, 'tenant');
    await resident(ESTATE_A, 'domestic-staff');

    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    const published = await announcementService.publish(context, created._id.toHexString());

    expect(published.status).toBe('published');
    // Author included: they live on the estate too.
    expect(published.notifiedCount).toBe(3);
    expect(await NotificationModel.countDocuments()).toBe(3);

    // Announcements default to email on and SMS off — an estate notice is not
    // worth a per-message carrier charge to every resident.
    expect(email.sent).toHaveLength(3);
    expect(email.sent[0]!.subject).toBe('Water supply interruption');
  });

  it('reaches only the targeted categories', async () => {
    const author = await resident(ESTATE_A, 'homeowner');
    await resident(ESTATE_A, 'tenant');
    await resident(ESTATE_A, 'domestic-staff');

    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context, {
      title: 'Service charge review',
      audience: { type: 'categories', categories: ['homeowner', 'landlord'] },
    });

    const published = await announcementService.publish(context, created._id.toHexString());

    expect(published.notifiedCount).toBe(1);

    const recipients = await NotificationModel.find().lean();
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.recipientMembershipId.toHexString()).toBe(author.membershipId);
  });

  it('skips members who are not active', async () => {
    const author = await resident(ESTATE_A);
    await resident(ESTATE_A, 'tenant', 'suspended');

    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    // A suspended member is not part of the conversation.
    expect((await announcementService.publish(context, created._id.toHexString())).notifiedCount)
      .toBe(1);
  });

  it('never crosses the estate boundary', async () => {
    const author = await resident(ESTATE_A);
    const outsider = await resident(ESTATE_B);

    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    await announcementService.publish(context, created._id.toHexString());

    const theirNotifications = await NotificationModel.find({
      recipientMembershipId: new mongoose.Types.ObjectId(outsider.membershipId),
    }).lean();
    expect(theirNotifications).toHaveLength(0);

    const theirFeed = await announcementService.list(ctx(ESTATE_B, outsider.userId));
    expect(theirFeed.items).toHaveLength(0);
  });

  it('is idempotent — publishing twice does not notify twice', async () => {
    const author = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    await announcementService.publish(context, created._id.toHexString());
    await announcementService.publish(context, created._id.toHexString());

    expect(await NotificationModel.countDocuments()).toBe(1);
  });

  it('requires both the publish and the send permission', async () => {
    const author = await resident(ESTATE_A);
    const created = await draft(ctx(ESTATE_A, author.userId));

    // Publishing IS sending: someone who may draft and publish text but holds
    // no send permission must not be able to push it to every handset.
    await expect(
      announcementService.publish(
        ctx(ESTATE_A, author.userId, [
          PERMISSIONS.ANNOUNCEMENT_VIEW,
          PERMISSIONS.ANNOUNCEMENT_CREATE,
          PERMISSIONS.ANNOUNCEMENT_PUBLISH,
        ]),
        created._id.toHexString(),
      ),
    ).rejects.toThrow(/notification.send/);
  });

  it('shows published, unexpired announcements to residents', async () => {
    const author = await resident(ESTATE_A);
    const reader = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, author.userId);

    const live = await draft(context);
    await announcementService.publish(context, live._id.toHexString());

    const stale = await draft(context, {
      title: 'Expired notice',
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    await announcementService.publish(context, stale._id.toHexString());

    const feed = await announcementService.list(
      ctx(ESTATE_A, reader.userId, [PERMISSIONS.ANNOUNCEMENT_VIEW]),
    );

    expect(feed.items.map((item) => item.title)).toEqual(['Water supply interruption']);
  });
});

describe('editing', () => {
  it('allows a draft to be rewritten', async () => {
    const author = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    const updated = await announcementService.update(context, created._id.toHexString(), {
      title: 'Water supply interruption (revised)',
    });

    expect(updated.title).toBe('Water supply interruption (revised)');
  });

  it('freezes the text of a published announcement', async () => {
    const author = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);
    await announcementService.publish(context, created._id.toHexString());

    // Residents were already told. Silently rewriting what they were told, after
    // they acted on it, is how a notice becomes a dispute nobody can settle.
    await expect(
      announcementService.update(context, created._id.toHexString(), { body: 'Actually, 8pm.' }),
    ).rejects.toThrow(/cannot be rewritten/i);

    // Pinning and expiry do not change what was said, so they stay editable.
    const pinned = await announcementService.update(context, created._id.toHexString(), {
      pinned: true,
    });
    expect(pinned.pinned).toBe(true);
  });

  /**
   * Archiving is a status change, not a deletion.
   *
   * It used to soft-delete as well, which put the record beyond the
   * repository's default filter — so an administrator who archived a notice
   * could no longer find it, and archiving was indistinguishable from deleting.
   */
  it('archives without putting the record beyond reach', async () => {
    const author = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    await announcementService.archive(context, created._id.toHexString());

    const stored = await AnnouncementModel.findById(created._id).lean();
    expect(stored?.status).toBe('archived');
    expect(stored?.archivedAt).not.toBeNull();
    expect(stored?.deletedAt ?? null).toBeNull();

    // And an administrator can still list it.
    const archived = await announcementService.list(context, { status: 'archived' });
    expect(archived.items.map((item) => item._id.toHexString())).toContain(
      created._id.toHexString(),
    );
  });

  it('will not publish something that was archived', async () => {
    const author = await resident(ESTATE_A);
    const context = ctx(ESTATE_A, author.userId);
    const created = await draft(context);

    await AnnouncementModel.updateOne({ _id: created._id }, { $set: { status: 'archived' } });

    await expect(
      announcementService.publish(context, created._id.toHexString()),
    ).rejects.toThrow(/archived/i);
  });
});
