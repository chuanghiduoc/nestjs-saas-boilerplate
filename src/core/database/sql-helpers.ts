import type { Db } from './db.js';

/**
 * Escape cho LIKE/ILIKE với ký tự escape mặc định của Postgres ("\"): input của người dùng
 * được so khớp theo nghĩa đen. Giá trị vẫn phải truyền qua tham số `?`, không nối vào SQL.
 */
export const escapeLike = (s: string): string =>
  s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Đếm có trần: không bao giờ quét quá cap+1 dòng. `innerSql` là một SELECT không có ORDER BY/LIMIT.
 * Kết quả > cap nghĩa là "nhiều hơn cap" (xem `Paginator.offset`).
 */
export async function countUpTo(
  db: Db,
  innerSql: string,
  params: unknown[],
  cap: number,
): Promise<number> {
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new Error(`countUpTo: cap must be a positive integer, got ${cap}`);
  const [row] = await db.execute<{ n: string }>(
    `SELECT count(*)::text AS n FROM (${innerSql} LIMIT ?) AS capped`,
    [...params, cap + 1],
  );
  if (!row) throw new Error('countUpTo: count query returned no row');
  return Number(row.n);
}
