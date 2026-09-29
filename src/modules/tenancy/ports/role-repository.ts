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
}
