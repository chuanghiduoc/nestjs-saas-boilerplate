import type { TemplateKey, TemplateParams } from '../templates.js';

export type EmailRequest<K extends TemplateKey> = {
  template: K;
  to: string;
  params: TemplateParams<K>;
  /** Luôn bắt đầu bằng `<template>:` (DB ép bằng CHECK); trùng key thì không tạo thư mới. */
  idempotencyKey: string;
};

/** Port gửi email giao dịch; identity gọi, notifications cài đặt. Chỉ ghi DB + enqueue, không gọi SMTP. */
export abstract class EmailNotifications {
  abstract request<K extends TemplateKey>(
    req: EmailRequest<K>,
  ): Promise<{ created: boolean }>;
}
