import { Types } from 'mongoose';
import { config } from '@/core/config';
import { BaseRepository, type PaginatedResult } from '@/core/db';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { meService } from '@/modules/me';
import { membershipRepository } from '@/modules/membership/repository';
import type { ResidentCategory } from '@/modules/membership/schema';
import { notificationService } from '@/modules/notification';
import { AnnouncementModel, type AnnouncementDoc, type AnnouncementStatus } from './schema';

const log = createLogger('announcement');

class AnnouncementRepository extends BaseRepository<AnnouncementDoc> {
  constructor() {
    super(AnnouncementModel);
  }
}

export const announcementRepository = new AnnouncementRepository();

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  summary?: string;
  audience?: { type: 'all' | 'categories'; categories?: ResidentCategory[] };
  pinned?: boolean;
  expiresAt?: Date | null;
}

export type UpdateAnnouncementInput = Partial<CreateAnnouncementInput>;

export class AnnouncementService {
  /**
   * List announcements.
   *
   * What a caller sees depends on what they hold. Someone with
   * `announcement.create` is an author and sees drafts; everyone else sees only
   * what has been published and has not expired. Without that split, every
   * resident could read an unpublished levy increase the moment it was typed.
   */
  async list(
    context: RequestContext,
    options: { page?: number; limit?: number; status?: AnnouncementStatus } = {},
  ): Promise<PaginatedResult<AnnouncementDoc>> {
    assertCan(context, PERMISSIONS.ANNOUNCEMENT_VIEW);

    const isAuthor = can(context, PERMISSIONS.ANNOUNCEMENT_CREATE);

    const filter: Record<string, unknown> = isAuthor
      ? options.status
        ? { status: options.status }
        : {}
      : {
          status: 'published',
          $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
        };

    return announcementRepository.paginate(
      context,
      filter,
      { page: options.page ?? 1, limit: options.limit ?? 25 },
      { sort: { pinned: -1, publishedAt: -1, createdAt: -1 } },
    );
  }

  async get(context: RequestContext, id: string): Promise<AnnouncementDoc> {
    assertCan(context, PERMISSIONS.ANNOUNCEMENT_VIEW);

    const announcement = await announcementRepository.findByIdOrFail(context, id);

    // A draft is a 404 to a resident rather than a 403: confirming that an
    // unpublished announcement exists is itself the leak.
    if (announcement.status !== 'published' && !can(context, PERMISSIONS.ANNOUNCEMENT_CREATE)) {
      const { NotFoundError } = await import('@/core/errors');
      throw new NotFoundError('Announcement');
    }

    return announcement;
  }

  async create(
    context: RequestContext,
    input: CreateAnnouncementInput,
  ): Promise<AnnouncementDoc> {
    assertCan(context, PERMISSIONS.ANNOUNCEMENT_CREATE);

    const audience = this.normaliseAudience(input.audience);
    const authorMembershipId = await meService.membershipId(context);

    // Created as a draft, always. Publishing is a separate act behind a separate
    // permission, so writing an announcement and sending it to an entire estate
    // are never the same keystroke.
    const announcement = await announcementRepository.create(context, {
      title: input.title.trim(),
      body: input.body,
      summary: (input.summary ?? this.summarise(input.body)).trim(),
      status: 'draft',
      audience,
      pinned: input.pinned ?? false,
      expiresAt: input.expiresAt ?? null,
      authorMembershipId: new Types.ObjectId(authorMembershipId),
      notifiedCount: 0,
    });

    await auditService.record(context, {
      action: 'announcement.created',
      resource: 'announcement',
      resourceId: announcement._id,
      metadata: { title: announcement.title, audience: audience.type },
    });

    return announcement;
  }

  /**
   * Edit an announcement.
   *
   * A published announcement's text is frozen. Residents have already been sent
   * the summary, and silently rewriting what they were told — after they acted
   * on it — is how a "the gate closes at 10pm" notice becomes a dispute nobody
   * can settle. Pinning and expiry stay editable because neither changes what
   * was said.
   */
  async update(
    context: RequestContext,
    id: string,
    changes: UpdateAnnouncementInput,
  ): Promise<AnnouncementDoc> {
    assertCan(context, PERMISSIONS.ANNOUNCEMENT_UPDATE);

    const existing = await announcementRepository.findByIdOrFail(context, id);

    const update: Record<string, unknown> = {};

    if (changes.pinned !== undefined) update.pinned = changes.pinned;
    if (changes.expiresAt !== undefined) update.expiresAt = changes.expiresAt;

    if (existing.status === 'draft') {
      if (changes.title !== undefined) update.title = changes.title.trim();
      if (changes.body !== undefined) update.body = changes.body;
      if (changes.summary !== undefined) update.summary = changes.summary.trim();
      if (changes.audience !== undefined) update.audience = this.normaliseAudience(changes.audience);
    } else if (
      changes.title !== undefined ||
      changes.body !== undefined ||
      changes.summary !== undefined ||
      changes.audience !== undefined
    ) {
      throw new ConflictError(
        'A published announcement cannot be rewritten. Archive it and publish a correction.',
      );
    }

    const updated = await announcementRepository.updateById(context, id, { $set: update });

    await auditService.record(context, {
      action: 'announcement.updated',
      resource: 'announcement',
      resourceId: id,
      before: { status: existing.status, pinned: existing.pinned },
      after: { status: updated.status, pinned: updated.pinned },
    });

    return updated;
  }

  /**
   * Publish, and fan out to the audience.
   *
   * The fan-out runs after the status change is committed. If notification
   * delivery collapsed halfway through, the announcement is still published —
   * `notificationService.send` swallows its own failures precisely so that a
   * partial fan-out cannot leave an announcement stuck in draft with half the
   * estate already told.
   */
  async publish(context: RequestContext, id: string): Promise<AnnouncementDoc> {
    assertCan(context, PERMISSIONS.ANNOUNCEMENT_PUBLISH);
    // Publishing IS sending: it puts a message in front of every targeted
    // resident on whatever channels they have enabled.
    assertCan(context, PERMISSIONS.NOTIFICATION_SEND);

    const announcement = await announcementRepository.findByIdOrFail(context, id);

    if (announcement.status === 'published') return announcement;
    if (announcement.status === 'archived') {
      throw new ConflictError('An archived announcement cannot be published.');
    }

    const publisherMembershipId = await meService.membershipId(context);

    const published = await announcementRepository.updateById(context, id, {
      $set: {
        status: 'published',
        publishedAt: new Date(),
        publishedByMembershipId: new Types.ObjectId(publisherMembershipId),
      },
    });

    const audience = await this.resolveAudience(context, published);

    const notified = await notificationService.sendMany(context, audience, {
      templateId: 'announcement.published',
      data: {
        title: published.title,
        summary: published.summary,
        announcementId: id,
      },
      resourceType: 'announcement',
      resourceId: id,
    });

    await announcementRepository.updateById(context, id, { $set: { notifiedCount: notified } });

    await auditService.record(context, {
      action: 'announcement.published',
      resource: 'announcement',
      resourceId: id,
      metadata: { title: published.title, audience: published.audience.type, notified },
    });

    log.info({ announcementId: id, notified }, 'announcement published');

    return { ...published, notifiedCount: notified };
  }

  /** Take it down. Soft delete, so the audit trail still resolves what was said. */
  async archive(context: RequestContext, id: string): Promise<void> {
    assertCan(context, PERMISSIONS.ANNOUNCEMENT_DELETE);

    // Status only. Soft-deleting as well put the record beyond the repository's
    // default filter, so an administrator who archived a notice could no longer
    // find it — archiving looked identical to deleting, which is not what they
    // chose. Residents stop seeing it because the read view filters on status.
    await announcementRepository.updateById(
      context,
      id,
      { $set: { status: 'archived', archivedAt: new Date() } },
    );

    await auditService.record(context, {
      action: 'announcement.archived',
      resource: 'announcement',
      resourceId: id,
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Which memberships an announcement targets.
   *
   * Active only: a suspended member is not part of the conversation, and an
   * exited tenant should not keep receiving their former estate's notices.
   * Capped, because an unbounded fan-out on a very large estate would hold a
   * request open writing tens of thousands of records.
   */
  private async resolveAudience(
    context: RequestContext,
    announcement: AnnouncementDoc,
  ): Promise<string[]> {
    const filter: Record<string, unknown> = { status: 'active' };

    if (announcement.audience.type === 'categories') {
      if (announcement.audience.categories.length === 0) return [];
      filter.category = { $in: announcement.audience.categories };
    }

    const memberships = await membershipRepository.findMany(context, filter, {
      sort: { createdAt: 1 },
      select: '_id',
    });

    const limit = config.notifications.announcementFanoutLimit;

    if (memberships.length > limit) {
      log.warn(
        { announcementId: announcement._id.toHexString(), audience: memberships.length, limit },
        'announcement audience exceeds the fan-out limit; truncated',
      );
    }

    return memberships.slice(0, limit).map((membership) => membership._id.toHexString());
  }

  private normaliseAudience(
    audience: CreateAnnouncementInput['audience'],
  ): { type: 'all' | 'categories'; categories: ResidentCategory[] } {
    if (!audience || audience.type === 'all') return { type: 'all', categories: [] };

    const categories = audience.categories ?? [];

    // An empty category list would target nobody while looking like a valid
    // send, so it is rejected rather than published into silence.
    if (categories.length === 0) {
      throw new UnprocessableError('Select at least one resident category, or target everyone.');
    }

    return { type: 'categories', categories };
  }

  /** First sentence, or the first 200 characters — whichever comes first. */
  private summarise(body: string): string {
    const text = body.replace(/\s+/g, ' ').trim();
    const sentenceEnd = text.indexOf('. ');
    if (sentenceEnd > 0 && sentenceEnd < 200) return text.slice(0, sentenceEnd + 1);
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  }
}

export const announcementService = new AnnouncementService();
