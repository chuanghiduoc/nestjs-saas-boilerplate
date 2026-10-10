import { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { TIMESTAMPTZ_MIN_YEAR } from '../constants.js';
import { CREATED_AT_KEY_PATTERN } from '../infra/sql/created-at-key.js';

/**
 * Cursor keyset `(created_at, public_id)` giảm dần, mờ với client: base64url chuẩn tắc của `[createdAtMicroIso, publicId]`.
 * Không ký: sửa cursor chỉ đổi vị trí bắt đầu trong tập client vốn được xem (lọc theo endpoint của path + RLS). Mọi dạng hỏng
 * → `400 invalid_cursor` trước khi chạm SQL (Review Focus 5); không bao giờ để Postgres ép kiểu hỏng (22007/22008 → 500).
 */
export type DeliveryCursorKey = { createdAt: string; publicId: string };
const Pair = z.tuple([z.string().regex(CREATED_AT_KEY_PATTERN), z.uuid()]);
const ISO_MS_LENGTH = 23; // `YYYY-MM-DDTHH:mm:ss.sss`
const invalid = () =>
  new AppError(CoreErrors.INVALID_CURSOR, {
    detail: 'The cursor is malformed or no longer valid',
    expected: true,
  });

export const encodeDeliveryCursor = (k: DeliveryCursorKey): string =>
  Buffer.from(JSON.stringify([k.createdAt, k.publicId]), 'utf8').toString(
    'base64url',
  );

export function decodeDeliveryCursor(raw: string): DeliveryCursorKey {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid();
  }
  const r = Pair.safeParse(value);
  if (!r.success) throw invalid();
  const [createdAt, publicId] = r.data;
  // Ngày không tồn tại (30/2) đổi giá trị khi qua Date: so phần mili giây để bắt.
  const d = new Date(createdAt);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() < TIMESTAMPTZ_MIN_YEAR ||
    d.toISOString().slice(0, ISO_MS_LENGTH) !==
      createdAt.slice(0, ISO_MS_LENGTH)
  )
    throw invalid();
  return { createdAt, publicId: publicId.toLowerCase() };
}
