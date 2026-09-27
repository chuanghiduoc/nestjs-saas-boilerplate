import { createHash } from 'node:crypto';

/** Một khoá cho mọi biến thể hoa thường/khoảng trắng/Unicode của cùng email (Review Focus 1). */
export const normalizeEmail = (email: string): string =>
  email.normalize('NFC').trim().toLowerCase();
/** Khoá lockout không bao giờ chứa email thật (không PII trong DB/log). */
export const emailHash = (email: string): string =>
  createHash('sha256').update(normalizeEmail(email)).digest('hex');
