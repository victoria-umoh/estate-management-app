import { Types } from 'mongoose';
import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { PaginatedResult } from '@/core/db';
import type { RequestContext } from '@/core/tenancy';
import { getEmailProvider, type EmailAttachment } from '@/integrations/notifications';
import { getQueue } from '@/integrations/queue';
import { meService } from '@/modules/me';
import { membershipRepository } from '@/modules/membership/repository';
import { userRepository } from '@/modules/user/repository';
import { notificationPreferenceRepository, notificationRepository } from './repository';
import {
  DEFAULT_CHANNEL_PREFERENCES,
  MANDATORY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  type ChannelPreference,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationDoc,
} from './schema';
import {
  NOTIFICATION_TEMPLATES,
  getTemplate,
  type NotificationTemplateDataMap,
  type NotificationTemplateId,
} from './templates';

const log = createLogger('notification');

export interface SendNotificationInput<TId extends NotificationTemplateId> {
  /** Who is being told. Always a membership — notifications are per-estate. */
  recipientMembershipId: string;
  templateId: TId;
  data: NotificationTemplateDataMap[TId];
  resourceType?: string;
  resourceId?: string;
}

export interface ResolvedChannels extends ChannelPreference {
  /** True when the resident's preferences were overridden because they could not opt out. */
  mandatory: boolean;
}

export class NotificationService {
  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /**
   * Notify one resident.
   *
   * NEVER THROWS. A notification is a side effect of something that already
   * happened — a payment settled, an emergency was raised — and the record of
   * that thing must not be rolled back because an SMS gateway was down or a
   * membership had been deleted between the event and the handler. The event bus
   * has the same property for the same reason; this is the second half of it,
   * because a handler that swallows nothing still hands the bus a rejection to
   * log on every single send.
   *
   * Returns the created record, or null when nothing was written.
   */
  async send<TId extends NotificationTemplateId>(
    context: RequestContext,
    input: SendNotificationInput<TId>,
  ): Promise<NotificationDoc | null> {
    try {
      return await this.dispatch(context, input);
    } catch (error) {
      log.error(
        { err: error, templateId: input.templateId, recipient: input.recipientMembershipId },
        'notification send failed',
      );
      return null;
    }
  }

  /**
   * Notify several residents.
   *
   * Sequential rather than `Promise.all`: a fan-out to a large estate would
   * otherwise open thousands of concurrent database writes and queue pushes at
   * once, and the queue — not the request — is where that work belongs anyway.
   */
  async sendMany<TId extends NotificationTemplateId>(
    context: RequestContext,
    recipientMembershipIds: readonly string[],
    input: Omit<SendNotificationInput<TId>, 'recipientMembershipId'>,
  ): Promise<number> {
    let sent = 0;

    for (const recipientMembershipId of recipientMembershipIds) {
      const record = await this.send(context, { ...input, recipientMembershipId });
      if (record) sent += 1;
    }

    return sent;
  }

  /**
   * Send on an administrator's behalf.
   *
   * The permission-checked entry point. `send()` itself is uncheckable by
   * design — it runs from event handlers under a system context — so the guard
   * belongs on the path a human can reach.
   */
  async sendAsAdministrator<TId extends NotificationTemplateId>(
    context: RequestContext,
    input: SendNotificationInput<TId>,
  ): Promise<NotificationDoc | null> {
    assertCan(context, PERMISSIONS.NOTIFICATION_SEND);
    return this.send(context, input);
  }

  /**
   * Send a template to a bare email address.
   *
   * The account flows — verify your email, reset your password, accept an
   * invitation — address a PERSON, not a membership. The invitee has no account
   * yet; someone resetting a password cannot sign in to read an in-app message
   * about how to sign in. So there is no notification record and no preference
   * lookup: these are transactional, they are the only way the recipient can
   * proceed, and a resident who muted "account" notifications has not asked to
   * be locked out of their own account.
   *
   * Never throws, for the same reason `send` does not: a registration must not
   * be rolled back because the mail queue was briefly unreachable.
   */
  async sendToAddress<TId extends NotificationTemplateId>(input: {
    to: string;
    templateId: TId;
    data: NotificationTemplateDataMap[TId];
  }): Promise<boolean> {
    try {
      const template = getTemplate(input.templateId);
      const rendered = template.render(input.data);

      const queue = await getQueue();
      await queue.enqueue('notification.email', {
        to: input.to,
        templateId: template.id,
        data: { subject: rendered.emailSubject, text: rendered.emailText },
      });

      return true;
    } catch (error) {
      // The address is deliberately not logged: these calls are made on paths
      // that must not confirm whether an address is registered, and a log line
      // is read by more people than a response body.
      log.error({ err: error, templateId: input.templateId }, 'direct notification send failed');
      return false;
    }
  }

  /**
   * Send a rendered template with a file attached, directly to the provider.
   *
   * Deliberately bypasses the queue. A job payload is JSON, and a Buffer does
   * not survive that round trip intact — encoding it to base64 to fit would put
   * a multi-megabyte string in the queue for every scheduled report.
   *
   * Only callers already running off-request should use this: there is no
   * retry, and the send is awaited. The scheduled-report sweep is one.
   */
  async sendWithAttachment<TId extends NotificationTemplateId>(input: {
    to: string;
    templateId: TId;
    data: NotificationTemplateDataMap[TId];
    attachments: EmailAttachment[];
  }): Promise<boolean> {
    try {
      const template = getTemplate(input.templateId);
      const rendered = template.render(input.data);

      const provider = await getEmailProvider();
      const result = await provider.send({
        to: input.to,
        subject: rendered.emailSubject,
        text: rendered.emailText,
        attachments: input.attachments,
      });

      return result.delivered;
    } catch (error) {
      log.error({ err: error, templateId: input.templateId }, 'attachment send failed');
      return false;
    }
  }

  private async dispatch<TId extends NotificationTemplateId>(
    context: RequestContext,
    input: SendNotificationInput<TId>,
  ): Promise<NotificationDoc | null> {
    const template = getTemplate(input.templateId);
    const rendered = template.render(input.data);

    const channels = await this.resolveChannels(
      context,
      input.recipientMembershipId,
      template.category,
    );

    // The in-app record is written FIRST and unconditionally. It is the durable
    // copy: if email and SMS both fail, the resident still finds the message
    // when they next open the app. Enqueueing before writing would risk an
    // email arriving about a notification that does not exist.
    const notification = await notificationRepository.create(context, {
      recipientMembershipId: new Types.ObjectId(input.recipientMembershipId),
      templateId: template.id,
      category: template.category,
      priority: template.priority,
      title: rendered.title,
      body: rendered.body,
      actionUrl: rendered.actionUrl ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      dispatchedChannels: [],
    });

    const dispatched = await this.enqueueOutbound(
      context,
      input.recipientMembershipId,
      channels,
      rendered,
      notification._id.toHexString(),
      template.id,
    );

    if (dispatched.length > 0) {
      await notificationRepository.updateById(context, notification._id, {
        $set: { dispatchedChannels: dispatched },
      });
    }

    return { ...notification, dispatchedChannels: dispatched };
  }

  private async enqueueOutbound(
    context: RequestContext,
    membershipId: string,
    channels: ResolvedChannels,
    rendered: { emailSubject: string; emailText: string; smsBody: string },
    notificationId: string,
    templateId: string,
  ): Promise<NotificationChannel[]> {
    const dispatched: NotificationChannel[] = ['in-app'];

    if (!channels.email && !channels.sms) return dispatched;

    const membership = await membershipRepository.findById(context, membershipId);
    if (!membership) return dispatched;

    const user = await userRepository.findById(membership.userId);
    if (!user) return dispatched;

    const queue = await getQueue();

    if (channels.email && user.email) {
      await queue.enqueue('notification.email', {
        to: user.email,
        templateId,
        // The rendered text travels with the job rather than being re-rendered
        // in the worker: the worker has no tenant context, and a template
        // deployed between enqueue and run would otherwise send different words
        // than the in-app record shows.
        data: { subject: rendered.emailSubject, text: rendered.emailText, notificationId },
      });
      dispatched.push('email');
    }

    if (channels.sms && user.phone) {
      await queue.enqueue('notification.sms', {
        to: user.phone,
        templateId,
        data: { body: rendered.smsBody, notificationId },
      });
      dispatched.push('sms');
    }

    return dispatched;
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  /**
   * Which channels this notification actually goes out on.
   *
   * THE MANDATORY RULE LIVES HERE, not in the UI. A resident who muted alerts
   * six months ago must still be told their gate has reported an emergency, and
   * a rule enforced only by a hidden toggle is a rule that any API client — or
   * any stale mobile build — ignores for free.
   */
  async resolveChannels(
    context: RequestContext,
    membershipId: string,
    category: NotificationCategory,
  ): Promise<ResolvedChannels> {
    if (MANDATORY_CATEGORIES.has(category)) {
      return { inApp: true, email: true, sms: true, mandatory: true };
    }

    const preference = await notificationPreferenceRepository.findOne(context, {
      membershipId: new Types.ObjectId(membershipId),
    });

    const resolved = preference?.categories?.[category] ?? DEFAULT_CHANNEL_PREFERENCES[category];

    return {
      // In-app is never switched off: it is the record, not a channel. Turning
      // it off would mean a resident who muted billing has no way at all to
      // discover they owe money.
      inApp: true,
      email: resolved.email,
      sms: resolved.sms,
      mandatory: false,
    };
  }

  /** The caller's own preferences, filled in with defaults for anything unset. */
  async preferencesForCaller(
    context: RequestContext,
  ): Promise<Record<NotificationCategory, ChannelPreference>> {
    const membershipId = await meService.membershipId(context);
    const stored = await notificationPreferenceRepository.findOne(context, {
      membershipId: new Types.ObjectId(membershipId),
    });

    return this.withDefaults(stored?.categories);
  }

  /**
   * Update the caller's own preferences.
   *
   * Changes to a mandatory category are accepted and ignored rather than
   * rejected: the client may be an old build that still shows the toggle, and
   * failing the whole request would lose the legitimate changes alongside it.
   * What comes back is what was actually stored.
   */
  async updatePreferencesForCaller(
    context: RequestContext,
    changes: Partial<Record<NotificationCategory, Partial<ChannelPreference>>>,
  ): Promise<Record<NotificationCategory, ChannelPreference>> {
    const membershipId = await meService.membershipId(context);

    const current = await this.preferencesForCaller(context);
    const next = this.withDefaults(current);

    for (const category of NOTIFICATION_CATEGORIES) {
      if (MANDATORY_CATEGORIES.has(category)) {
        next[category] = { ...DEFAULT_CHANNEL_PREFERENCES[category] };
        continue;
      }

      const change = changes[category];
      if (!change) continue;

      next[category] = {
        inApp: true,
        email: change.email ?? next[category].email,
        sms: change.sms ?? next[category].sms,
      };
    }

    const existing = await notificationPreferenceRepository.findOne(context, {
      membershipId: new Types.ObjectId(membershipId),
    });

    if (existing) {
      await notificationPreferenceRepository.updateById(context, existing._id, {
        $set: { categories: next },
      });
    } else {
      await notificationPreferenceRepository.create(context, {
        membershipId: new Types.ObjectId(membershipId),
        categories: next,
      });
    }

    return next;
  }

  private withDefaults(
    stored?: Partial<Record<NotificationCategory, ChannelPreference>>,
  ): Record<NotificationCategory, ChannelPreference> {
    const result = {} as Record<NotificationCategory, ChannelPreference>;

    for (const category of NOTIFICATION_CATEGORIES) {
      const value = stored?.[category];
      result[category] = MANDATORY_CATEGORIES.has(category)
        ? { ...DEFAULT_CHANNEL_PREFERENCES[category] }
        : {
            inApp: true,
            email: value?.email ?? DEFAULT_CHANNEL_PREFERENCES[category].email,
            sms: value?.sms ?? DEFAULT_CHANNEL_PREFERENCES[category].sms,
          };
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * The caller's own notifications.
   *
   * The membership comes from the session via meService, never from the
   * request. A route that accepted a membership id here would let anyone read
   * another household's notifications by changing one value in dev tools.
   */
  async listForCaller(
    context: RequestContext,
    options: { page?: number; limit?: number; unreadOnly?: boolean } = {},
  ): Promise<PaginatedResult<NotificationDoc>> {
    const membershipId = await meService.membershipId(context);

    return notificationRepository.paginate(
      context,
      {
        recipientMembershipId: new Types.ObjectId(membershipId),
        ...(options.unreadOnly ? { readAt: null } : {}),
      },
      { page: options.page ?? 1, limit: options.limit ?? 25 },
      { sort: { createdAt: -1 } },
    );
  }

  async unreadCountForCaller(context: RequestContext): Promise<number> {
    const membershipId = await meService.membershipId(context);

    return notificationRepository.count(context, {
      recipientMembershipId: new Types.ObjectId(membershipId),
      readAt: null,
    });
  }

  /**
   * Mark one as read.
   *
   * Filtered by recipient as well as id, so a notification belonging to someone
   * else is a 404 — marking another resident's alert read would hide it from
   * them.
   */
  async markRead(context: RequestContext, notificationId: string): Promise<NotificationDoc> {
    const membershipId = await meService.membershipId(context);

    const updated = await notificationRepository.updateOne(
      context,
      {
        _id: new Types.ObjectId(notificationId),
        recipientMembershipId: new Types.ObjectId(membershipId),
      },
      { $set: { readAt: new Date() } },
    );

    if (!updated) {
      const { NotFoundError } = await import('@/core/errors');
      throw new NotFoundError('Notification');
    }

    return updated;
  }

  async markAllRead(context: RequestContext): Promise<number> {
    const membershipId = await meService.membershipId(context);

    return notificationRepository.updateMany(
      context,
      { recipientMembershipId: new Types.ObjectId(membershipId), readAt: null },
      { $set: { readAt: new Date() } },
    );
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  /**
   * What the platform can say.
   *
   * Read-only by construction: there is no counterpart that writes. See the
   * note at the top of templates.ts for why.
   */
  listTemplates(context: RequestContext) {
    assertCan(context, PERMISSIONS.NOTIFICATION_TEMPLATE_MANAGE);

    return Object.values(NOTIFICATION_TEMPLATES).map((template) => ({
      id: template.id,
      category: template.category,
      priority: template.priority,
      description: template.description,
      silenceable: !MANDATORY_CATEGORIES.has(template.category),
    }));
  }

  /**
   * Discard notifications past the retention window.
   *
   * Called by housekeeping. Hard delete, not soft: a read notification about a
   * visitor pass from two years ago is noise in the audit trail, and the events
   * themselves are recorded in their own collections.
   */
  async purgeExpired(context: RequestContext): Promise<number> {
    const cutoff = new Date(Date.now() - config.notifications.retentionDays * 86_400_000);

    return notificationRepository.updateMany(
      context,
      { createdAt: { $lt: cutoff }, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
  }
}

export const notificationService = new NotificationService();
