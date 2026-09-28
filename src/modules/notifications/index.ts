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
// M1 (S2-R75 review, identity/security-notice.service.ts): caller phải phân biệt lỗi VĨNH VIỄN (địa chỉ/params sai)
// khỏi lỗi hạ tầng tạm thời, để không thử lại vô hạn một marker không bao giờ gửi được.
export { InvalidEmailRequestError } from './errors.js';
