import { BaseRepository } from '@/core/db';
import {
  NotificationModel,
  NotificationPreferenceModel,
  type NotificationDoc,
  type NotificationPreferenceDoc,
} from './schema';

/**
 * Both collections are tenant-scoped through BaseRepository, so a notification
 * raised in one estate can never be read — or marked read — from another, even
 * if its id leaks.
 */
class NotificationRepository extends BaseRepository<NotificationDoc> {
  constructor() {
    super(NotificationModel);
  }
}

class NotificationPreferenceRepository extends BaseRepository<NotificationPreferenceDoc> {
  constructor() {
    super(NotificationPreferenceModel);
  }
}

export const notificationRepository = new NotificationRepository();
export const notificationPreferenceRepository = new NotificationPreferenceRepository();
