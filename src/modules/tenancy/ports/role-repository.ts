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
}
