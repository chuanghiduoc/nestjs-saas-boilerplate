import type { SystemRoleKey } from '../../constants.js';
import type { MergedCatalogue } from '../../domain/catalogue.js';
import { systemRolePermissions } from '../../domain/system-roles.js';

/**
 * Quyền hiệu lực của principal member (spec SP3 §7.1 bước 3.9): role hệ thống tính trong code từ catalogue gộp, không
 * cache (PR18). Role tuỳ biến (3B thêm câu thứ hai của đường nóng) chưa tồn tại ở 3A: một dòng như vậy chỉ có thể do SQL
 * tay tạo ra → lỗi 500 có log, không bao giờ âm thầm cấp tập rỗng. Plan 3B thay nhánh này (Bảng 5 của spec).
 */
export function effectivePermissions(
  role: { systemKey: SystemRoleKey | null },
  merged: MergedCatalogue,
): string[] {
  if (role.systemKey === null)
    throw new Error(
      'custom roles are introduced by plan 3B; a custom role reached the 3A hot path',
    );
  return [...systemRolePermissions(role.systemKey, merged)].sort();
}
