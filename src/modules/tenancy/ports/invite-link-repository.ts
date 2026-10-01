import type { SystemRoleKey } from '../constants.js';
import type { TokenMatch } from './invitation-repository.js';

export type InviteLinkRow = {
  id: string;
  publicId: string;
  roleId: string | null;
  rolePublicId: string | null;
  roleSystemKey: SystemRoleKey | null;
  roleName: string | null;
  createdByMemberId: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export abstract class InviteLinkRepository {
  abstract findByTokenHash(hashHex: string): Promise<TokenMatch | undefined>;
  abstract insert(l: {
    roleId: string;
    createdByMemberId: string;
    tokenHashHex: string;
    maxUses: number;
    expiresAt: Date;
  }): Promise<InviteLinkRow>;
  abstract findByPublicId(publicId: string): Promise<InviteLinkRow | undefined>;
  abstract findById(id: string): Promise<InviteLinkRow | undefined>;
  abstract lockById(id: string): Promise<InviteLinkRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<InviteLinkRow | undefined>;
  /** Link "đang mở" (§6.8 DB-M2) theo `clock_timestamp()`: chưa thu hồi, chưa hết hạn, chưa hết lượt. */
  abstract countOpen(): Promise<number>;
  /** Câu điều kiện atomic (T-5, T-29): tăng `use_count` khi còn mở; `undefined` khi không. */
  abstract consumeUse(id: string): Promise<InviteLinkRow | undefined>;
  /** `revoked_at = clock_timestamp()` khi còn NULL; `undefined` khi đã thu hồi. */
  abstract revoke(id: string): Promise<InviteLinkRow | undefined>;
  /** Xoá role (Bảng 5): thu hồi link chưa thu hồi mà KHÔNG còn mở của role; trả dòng đã thu hồi để phát event. */
  abstract revokeClosedForRole(
    roleId: string,
  ): Promise<{ publicId: string; version: number }[]>;
  /** Xoá mềm org: thu hồi mọi link chưa thu hồi (không event riêng, §14.1). */
  abstract revokeAll(): Promise<void>;
  abstract list(q: { limit: number; offset: number }): Promise<InviteLinkRow[]>;
  abstract countUpTo(cap: number): Promise<number>;
}
