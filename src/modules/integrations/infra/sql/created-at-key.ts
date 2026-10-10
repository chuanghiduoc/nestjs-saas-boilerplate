/**
 * `created_at` của message/delivery là một phần của khoá (partition + FK). App mang nó dưới dạng chuỗi ISO micro giây UTC,
 * không qua `Date` (mili giây): `created_at = ?::timestamptz` với giá trị mất micro giây sẽ không khớp dòng nào.
 */
export const CREATED_AT_KEY_SQL = (alias: string): string =>
  `to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Cùng định dạng, cho zod (cursor, test). */
export const CREATED_AT_KEY_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
