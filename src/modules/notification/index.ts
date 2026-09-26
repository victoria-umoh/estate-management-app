export {
  notificationService,
  NotificationService,
  type ResolvedChannels,
  type SendNotificationInput,
} from './service';
export { notificationRepository, notificationPreferenceRepository } from './repository';
export { registerNotificationHandlers, unregisterNotificationHandlers } from './handlers';
export { registerNotificationJobs, resetNotificationJobs } from './jobs';
export {
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_IDS,
  getTemplate,
  type NotificationTemplate,
  type NotificationTemplateDataMap,
  type NotificationTemplateId,
  type RenderedNotification,
} from './templates';
export {
  NotificationModel,
  NotificationPreferenceModel,
  NOTIFICATION_CATEGORIES,
  MANDATORY_CATEGORIES,
  DEFAULT_CHANNEL_PREFERENCES,
  type ChannelPreference,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationDoc,
  type NotificationPreferenceDoc,
  type NotificationPriority,
} from './schema';
