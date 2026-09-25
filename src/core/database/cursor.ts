import { Cursor, CursorError } from '@mikro-orm/core';
import { AppError, CoreErrors } from '../errors/index.js';
import { pgFields } from './db-error.mapper.js';

/** SQLSTATE lớp 22 (data exception): giá trị trong cursor không ép được về kiểu của cột sort. */
const PG_DATA_EXCEPTION_CLASS = '22';
/** SQLSTATE 42883 (undefined_function): vd. `text >= boolean` khi cursor mang giá trị sai kiểu. */
const PG_UNDEFINED_FUNCTION = '42883';
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
 * - MikroORM bỏ qua **im lặng** cursor có số phần tử khác số khoá `orderBy` (quay về trang đầu), và
 *   hiểu giá trị object/mảng trong cursor là cấu trúc truy vấn (vd. `{"$ne":null}`), nên cursor được
 *   kiểm tra trước khi chạy: đúng số phần tử, mỗi phần tử là giá trị JSON nguyên thuỷ.
 * - `orderBy` phải là object phẳng (hướng là chuỗi, không sort lồng qua quan hệ) kết thúc bằng một
 *   khoá duy nhất (vd. `{ createdAt: 'desc', id: 'desc' }`) để thứ tự ổn định.
 * - Khi có cursor, lỗi kiểu dữ liệu của Postgres (lớp 22, 42883) là do cursor → 400. Lỗi khác
 *   (timeout, mất kết nối…) được ném nguyên để map theo bảng lỗi DB.
 */
export async function withClientCursor<T>(
  cursor: string | undefined,
  orderBy: Readonly<Record<string, string>>,
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
  if (
    !Array.isArray(values) ||
    values.length !== keys ||
    !values.every(isPrimitiveJson)
  )
    throw invalidCursor();
}

const isPrimitiveJson = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));

const isCursorValueError = (err: unknown): boolean => {
  if (err instanceof CursorError) return true;
  const state = pgFields(err)?.sqlState;
  return (
    state !== undefined &&
    (state.startsWith(PG_DATA_EXCEPTION_CLASS) ||
      state === PG_UNDEFINED_FUNCTION)
  );
};
