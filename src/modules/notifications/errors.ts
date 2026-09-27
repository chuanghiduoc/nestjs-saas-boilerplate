/** SMTP chuẩn hoá (spec §5.14): trùng `CHECK (last_error_code IN (…))` của `email_deliveries`. */
export const MAIL_ERROR_CODES = [
  'SMTP_TRANSIENT',
  'SMTP_PERMANENT',
  'SMTP_TIMEOUT',
  'SMTP_CONNECTION',
] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

/**
 * Lỗi SMTP đã bỏ mọi dữ liệu người dùng: message cố định, không `cause`. Đây là thứ duy nhất vào log,
 * `last_error_code` và failed reason của BullMQ.
 */
export class MailSendError extends Error {
  constructor(
    readonly code: MailErrorCode,
    readonly responseCode?: number,
    readonly command?: string,
  ) {
    super(`SMTP send failed (${code})`);
    this.name = 'MailSendError';
  }
}
export const isTransientMailError = (code: MailErrorCode): boolean =>
  code !== 'SMTP_PERMANENT';

/** Delivery đang được worker khác giữ lease còn hạn: lỗi thường, BullMQ lùi lịch theo backoff. */
export class DeliveryLeaseBusyError extends Error {
  constructor() {
    super(
      'Email delivery is being sent by another worker (lease still active)',
    );
    this.name = 'DeliveryLeaseBusyError';
  }
}

/**
 * Caller gọi `EmailNotifications.request` sai (params ngoài schema, key của template khác, địa chỉ không hợp
 * lệ): lỗi lập trình của module gọi, không phải lỗi của người dùng cuối, nên KHÔNG là `AppError` (không thành
 * 4xx). Message chỉ nêu tên trường, không chứa giá trị (PII).
 */
export class InvalidEmailRequestError extends Error {
  constructor(detail: string) {
    super(`Invalid email request: ${detail}`);
    this.name = 'InvalidEmailRequestError';
  }
}
