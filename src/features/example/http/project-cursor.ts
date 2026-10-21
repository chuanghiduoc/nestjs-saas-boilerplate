import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';

/**
 * Cursor keyset một khoá `public_id` giảm dần (D7-1), mờ với client: base64url chuẩn tắc của `[publicId]`. Không ký: sửa
 * cursor chỉ đổi vị trí bắt đầu trong tập client vốn được xem (RLS của org). Mọi dạng hỏng → `400 invalid_cursor` trước khi
 * chạm SQL (Review Focus 1). Không có trường thời gian nên không cần guard năm như cursor delivery của 6C.
 */
const Key = z.tuple([z.uuid()]);
const invalid = () =>
  new AppError(CoreErrors.INVALID_CURSOR, {
    detail: 'The cursor is malformed or no longer valid',
    expected: true,
  });

export const encodeProjectCursor = (publicId: string): string =>
  Buffer.from(JSON.stringify([publicId]), 'utf8').toString('base64url');

export function decodeProjectCursor(raw: string): string {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid();
  }
  const r = Key.safeParse(value);
  if (!r.success) throw invalid();
  return r.data[0].toLowerCase();
}
