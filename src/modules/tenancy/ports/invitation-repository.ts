import type { SystemRoleKey } from '../constants.js';
import type { InvitationStatus } from '../domain/invitation.js';

export type InvitationRow = {
  id: string;
  publicId: string;
  email: string;
  roleId: string | null;
  rolePublicId: string | null;
  roleSystemKey: SystemRoleKey | null;
  roleName: string | null;
  inviterMemberId: string | null;
  status: InvitationStatus;
  expiresAt: Date;
  resolvedAt: Date | null;
  acceptedMemberId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Kết quả hàm definer tra token (không cần OrgScope; spec §6.14). */
export type TokenMatch = { orgId: string; id: string };

/** Mọi phương thức trừ `findByTokenHash` chạy trong OrgScope của org (RLS); `lock*` chỉ dưới khoá org (spec §8.6). */
export abstract class InvitationRepository {
  abstract findByTokenHash(hashHex: string): Promise<TokenMatch | undefined>;
  abstract insert(i: {
    email: string;
    roleId: string;
    inviterMemberId: string;
    tokenHashHex: string;
    ttlSec: number;
  }): Promise<InvitationRow>;
  abstract findByPublicId(publicId: string): Promise<InvitationRow | undefined>;
  abstract findById(id: string): Promise<InvitationRow | undefined>;
  abstract lockById(id: string): Promise<InvitationRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<InvitationRow | undefined>;
  /** PENDING chưa hết hạn theo `clock_timestamp()` (trần mỗi org, T-11). */
  abstract countOpen(): Promise<number>;
  /** PENDING đã hết hạn của cùng email → EXPIRED (không event, §14.1): giải phóng `pending_email_uq`. */
  abstract expireLapsedForEmail(email: string): Promise<void>;
  /** CAS PENDING → `to` (T-21); `undefined` khi dòng không còn PENDING. Xoá token, đặt `resolved_at`. */
  abstract resolve(
    id: string,
    to: 'REVOKED' | 'EXPIRED' | 'INVALIDATED',
  ): Promise<InvitationRow | undefined>;
  /** CAS PENDING và còn hạn theo `clock_timestamp()` → ACCEPTED (T-2, T-29). */
  abstract accept(
    id: string,
    acceptedMemberId: string,
  ): Promise<InvitationRow | undefined>;
  abstract list(q: { limit: number; offset: number }): Promise<InvitationRow[]>;
  abstract countUpTo(cap: number): Promise<number>;
  /** Xoá role (Bảng 5): PENDING đã hết hạn của role → EXPIRED, để `SET NULL (role_id)` không chạm PENDING còn sống. */
  abstract expireLapsedForRole(roleId: string): Promise<void>;
  /** Xoá mềm org (Bảng 5): mọi PENDING → REVOKED, không event riêng (§14.1). */
  abstract revokeAllPending(): Promise<void>;
}
