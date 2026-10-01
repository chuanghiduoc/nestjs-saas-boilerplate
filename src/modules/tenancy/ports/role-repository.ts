import type { SystemRoleKey } from '../constants.js';

export type RoleRow = {
  id: string;
  publicId: string;
  systemKey: SystemRoleKey | null;
  name: string | null;
  description: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export abstract class RoleRepository {
  abstract insertSystemRoles(): Promise<Record<SystemRoleKey, RoleRow>>;
  abstract list(): Promise<RoleRow[]>;
  abstract findByPublicId(publicId: string): Promise<RoleRow | undefined>;
  /** Key (không deprecated) đã lưu của các role tuỳ biến trong org hiện tại; mọi id đầu vào có mặt trong Map. */
  abstract permissionKeys(
    roleIds: readonly string[],
  ): Promise<Map<string, string[]>>;
  abstract insertCustom(r: {
    name: string;
    description: string | null;
  }): Promise<RoleRow>;
  /** `FOR NO KEY UPDATE` (spec §8.6 bước 3): sửa/xoá role tuần tự hoá với nhau và với gán role (đã khoá org trước). */
  abstract lockByPublicId(publicId: string): Promise<RoleRow | undefined>;
  /** Ghi tên/mô tả và tăng `version` (ETag, `aggregate.version`), kể cả khi chỉ tập quyền đổi. */
  abstract update(
    id: string,
    r: { name: string; description: string | null },
  ): Promise<RoleRow>;
  /** Tập đã lưu = `keys` (xoá dòng ngoài tập, chèn dòng thiếu); tập trung gian được trigger hoãn kiểm lúc COMMIT. */
  abstract replacePermissions(
    roleId: string,
    keys: ReadonlySet<string>,
  ): Promise<void>;
  abstract deleteById(id: string): Promise<void>;
}
