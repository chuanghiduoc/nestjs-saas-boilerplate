import type { SystemRoleKey } from '../constants.js';

export type MemberRow = {
  id: string;
  publicId: string;
  userId: string;
  userPublicId: string;
  authUserId: string | null;
  externalSubject: string | null;
  roleId: string;
  rolePublicId: string;
  systemKey: SystemRoleKey | null;
  roleName: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export abstract class MemberRepository {
  abstract insert(m: { userId: string; roleId: string }): Promise<MemberRow>;
  abstract findByPublicId(publicId: string): Promise<MemberRow | undefined>;
  abstract findByUserId(userId: string): Promise<MemberRow | undefined>;
  /** Đọc lại actor/target dưới khoá org, `FOR SHARE` theo `id` tăng dần (spec SP3 §8.6 bước 4). */
  abstract lockForShare(ids: readonly string[]): Promise<MemberRow[]>;
  abstract changeRole(id: string, roleId: string): Promise<MemberRow>;
  abstract deleteById(id: string): Promise<void>;
  abstract list(q: {
    roleId?: string;
    limit: number;
    offset: number;
  }): Promise<MemberRow[]>;
  abstract countUpTo(roleId: string | undefined, cap: number): Promise<number>;
}
