import { Cursor, CursorError } from '@mikro-orm/core';
import { AppError, CoreErrors } from '../errors/index.js';
import { pgFields } from './db-error.mapper.js';

/** SQLSTATE lớp 22 (data exception): giá trị trong cursor không ép được về kiểu của cột sort. */
const PG_DATA_EXCEPTION_CLASS = '22';
const INVALID_CURSOR_DETAIL = 'The cursor is malformed or no longer valid';

const invalidCursor = (cause?: unknown): AppError =>
  new AppError(CoreErrors.INVALID_CURSOR, {
    detail: INVALID_CURSOR_DETAIL,
    cause,
  });

/**
 * Chạy một truy vấn `findByCursor` với cursor do client gửi; mọi lỗi do cursor gây ra → `400 invalid_cursor`.
 *
 * - Cursor của MikroORM là base64url của mảng giá trị sort, KHÔNG ký: client đọc/sửa được. Sửa cursor
 *   chỉ đổi vị trí bắt đầu trong tập kết quả mà client vốn được xem (where/RLS vẫn áp dụng, giá trị
 *   luôn đi qua tham số), nên không cần ký.
 * - MikroORM bỏ qua **im lặng** cursor có số phần tử khác số khoá `orderBy` (quay về trang đầu),
 *   nên hình dạng được kiểm tra trước khi chạy.
 * - `orderBy` phải là object phẳng kết thúc bằng một khoá duy nhất (vd. `{ createdAt: 'desc', id: 'desc' }`)
 *   để thứ tự ổn định.
 * - Lỗi khác (timeout, mất kết nối…) được ném nguyên để map theo bảng lỗi DB.
 */
export async function withClientCursor<T>(
  cursor: string | undefined,
  orderBy: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> {
  if (cursor !== undefined)
    assertCursorShape(cursor, Object.keys(orderBy).length);
  try {
    return await run();
  } catch (err) {
    if (cursor !== undefined && isCursorValueError(err))
      throw invalidCursor(err);
    throw err;
  }
}

function assertCursorShape(cursor: string, keys: number): void {
  let values: unknown;
  try {
    values = Cursor.decode(cursor);
  } catch (err) {
    throw invalidCursor(err);
  }
  if (!Array.isArray(values) || values.length !== keys) throw invalidCursor();
}

const isCursorValueError = (err: unknown): boolean =>
  err instanceof CursorError ||
  (pgFields(err)?.sqlState.startsWith(PG_DATA_EXCEPTION_CLASS) ?? false);
