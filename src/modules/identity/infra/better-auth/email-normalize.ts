import { createHash } from 'node:crypto';

/**
 * Một khoá cho mọi biến thể hoa thường/khoảng trắng/Unicode của cùng email (Review Focus 1).
 * NFC áp dụng SAU CÙNG: `toLowerCase` có thể trả kết quả chưa ở dạng NFC (vd. `"T̈"` hạ
 * chữ hoa xong vẫn là tổ hợp rời), nên nếu NFC chạy trước thì hàm không idempotent. Chuẩn hoá
 * lại NFC ở bước cuối đảm bảo `normalizeEmail(normalizeEmail(x)) === normalizeEmail(x)` luôn
 * đúng (review Task 31 M2).
 */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase().normalize('NFC');
/** Khoá lockout không bao giờ chứa email thật (không PII trong DB/log). */
export const emailHash = (email: string): string =>
  createHash('sha256').update(normalizeEmail(email)).digest('hex');
