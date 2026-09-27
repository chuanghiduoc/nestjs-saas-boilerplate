export { NotificationsModule } from './notifications.module.js';
export {
  EmailNotifications,
  type EmailRequest,
} from './ports/email-notifications.js';
export {
  DISPLAY_NAME_MAX,
  displayName,
  TEMPLATE_KEYS,
  type TemplateKey,
  type TemplateParams,
} from './templates.js';
export { notificationsConfig, smtpConfig } from './notifications.config.js';
export { DeliveryFailedEvent } from './events.js';
