import type { SystemRoleKey } from '../constants.js';
import type { MergedCatalogue } from './catalogue.js';
import { closure } from './permission-set.js';

/**
 * Tập quyền của role hệ thống tính trong code từ catalogue gộp (S3-A5, spec §8.3): OWNER = mọi quyền không deprecated
 * của MỌI catalogue; ADMIN/MEMBER = closure của allow-list `grantTo`, bỏ deprecated. Không lưu ở DB.
 */
export function systemRolePermissions(
  key: SystemRoleKey,
  merged: MergedCatalogue,
): ReadonlySet<string> {
  const active = [...merged.values()].filter((e) => !e.deprecated);
  switch (key) {
    case 'OWNER':
      return new Set(active.map((e) => e.key));
    case 'ADMIN':
      return withoutDeprecated(
        closure(
          active.filter((e) => e.grantTo.admin).map((e) => e.key),
          merged,
        ),
        merged,
      );
    case 'MEMBER':
      return withoutDeprecated(
        closure(
          active.filter((e) => e.grantTo.member).map((e) => e.key),
          merged,
        ),
        merged,
      );
    default: {
      const unknown: never = key;
      throw new Error(`unknown system role ${String(unknown)}`);
    }
  }
}
const withoutDeprecated = (
  s: Set<string>,
  merged: MergedCatalogue,
): ReadonlySet<string> =>
  new Set([...s].filter((k) => merged.get(k)?.deprecated !== true));

/** `A = perms(ADMIN)` của luật 2a (spec §8.4): tính lại mỗi lần gộp catalogue, không lưu. */
export const adminCapability = (merged: MergedCatalogue): ReadonlySet<string> =>
  systemRolePermissions('ADMIN', merged);
