import type { SystemRoleKey } from '../../constants.js';
import type { MergedCatalogue } from '../../domain/catalogue.js';
import { systemRolePermissions } from '../../domain/system-roles.js';

/**
 * Quyền hiệu lực của role HỆ THỐNG (spec SP3 §7.1 bước 3.9): tính trong code từ catalogue gộp. Role tuỳ biến không đi qua
 * đây: tập của nó là dòng đã lưu, chỉ đọc bằng `RolePermissions` (câu thứ hai của đường nóng) rồi lọc bằng
 * `customRolePermissions`. Không cache (PR18).
 */
export function effectivePermissions(
  role: { systemKey: SystemRoleKey | null },
  merged: MergedCatalogue,
): string[] {
  if (role.systemKey === null)
    throw new Error(
      'a custom role has stored permissions: use RolePermissions',
    );
  return [...systemRolePermissions(role.systemKey, merged)].sort();
}

export type CustomRolePermissions = { granted: string[]; orphans: string[] };

/**
 * Tập đã lưu của một role tuỳ biến → quyền cấp thật (spec §7.3; R-X21, R-X23). Key deprecated trong code bị bỏ (U10; DB đã
 * lọc `deprecated_at`). Key không catalogue nào đã nạp khai báo là ORPHAN (module của nó bị tắt; dòng `permissions` ở lại
 * DB): không cấp gì và KHÔNG ném — route chỉ đến từ catalogue đã nạp nên không route nào đòi nó; ném ở đây sẽ biến mọi
 * request của người giữ role thành 500 và chặn cả owner sửa role để gỡ key (R-X23). Trả orphan để caller báo (WARN +
 * metric) và để `RoleService` gỡ nó khi sửa role.
 */
export function customRolePermissions(
  stored: readonly string[],
  merged: MergedCatalogue,
): CustomRolePermissions {
  const granted = new Set<string>();
  const orphans = new Set<string>();
  for (const key of stored) {
    const entry = merged.get(key);
    if (!entry) orphans.add(key);
    else if (!entry.deprecated) granted.add(key);
  }
  return { granted: [...granted].sort(), orphans: [...orphans].sort() };
}
