import { basename } from 'node:path';

const APP_MIGRATIONS = 'src/migrations/app/';
const STAMP = /^Migration(\d{14})_/;

/** Vùng của một migration (spec SP7 S7-D31): `app/` của dự án; mọi thư mục khác (kể cả `example/`) là boilerplate. */
export const migrationZone = (path: string): 'app' | 'boilerplate' =>
  path.replaceAll('\\', '/').startsWith(APP_MIGRATIONS) ? 'app' : 'boilerplate';

const stampOf = (path: string): string => {
  const m = STAMP.exec(basename(path.replaceAll('\\', '/')));
  if (!m?.[1])
    throw new Error(`${path} does not follow Migration<14 digits>_<name>.ts`);
  return m[1];
};

/**
 * Migration mới của nhánh không mới hơn migration mới nhất CÙNG VÙNG trên main (amendment B1): migration upstream đến
 * muộn với timestamp cũ hơn migration của dự án là hợp lệ (MikroORM chạy mọi migration chưa chạy, UP-10).
 */
export function migrationsNotNewerThanZone(
  onMain: readonly string[],
  added: readonly string[],
): string[] {
  const newest = (zone: 'app' | 'boilerplate') =>
    onMain
      .filter((f) => migrationZone(f) === zone)
      .map(stampOf)
      .sort()
      .at(-1) ?? '';
  return added.filter((f) => !(stampOf(f) > newest(migrationZone(f))));
}
