import { z } from 'zod';

/** Key template: trùng các dòng của bảng tra cứu `email_templates` (FK từ `email_deliveries.template`, spec SP3 §6.13) và tên thư mục `templates/<key>/`. Thêm template = thêm key ở đây + migration chèn dòng. */
export const TEMPLATE_KEYS = [
  'verify-email',
  'reset-password',
  'two-factor-changed',
  'existing-account',
  'change-email-confirmation',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
/** Cùng regex với `CHECK (locale ~ …)` của `email_deliveries` (spec §5.16c thay đổi 3). */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;
export const DISPLAY_NAME_MAX = 200;
/** Chuỗi hiển thị một dòng: không CR/LF (subject, text) — Review Focus 4. */
export const displayName = z
  .string()
  .max(DISPLAY_NAME_MAX)
  .regex(/^[^\r\n]*$/, 'must be a single line');

/**
 * Params theo template. Không template nào chứa địa chỉ người nhận (người nhận chỉ nằm ở `recipient_enc`,
 * spec §5.16c). `.strict()`: key lạ là lỗi của caller.
 */
export const TEMPLATE_PARAMS = {
  'verify-email': z.object({ name: displayName, url: z.url() }).strict(),
  'reset-password': z.object({ name: displayName, url: z.url() }).strict(),
  'two-factor-changed': z
    .object({
      name: displayName,
      enabled: z.boolean(),
      occurredAt: z.iso.datetime(),
    })
    .strict(),
  // Không có link: thư chỉ báo tài khoản đã tồn tại (không cần thêm config URL của frontend).
  'existing-account': z.object({ name: displayName }).strict(),
  'change-email-confirmation': z.object({ displayName, url: z.url() }).strict(),
} as const satisfies Record<TemplateKey, z.ZodObject>;
export type TemplateParams<K extends TemplateKey> = z.infer<
  (typeof TEMPLATE_PARAMS)[K]
>;

export const isTemplateKey = (v: string): v is TemplateKey =>
  (TEMPLATE_KEYS as readonly string[]).includes(v);
