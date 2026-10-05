import type { SystemRoleKey } from '../constants.js';

export type OrgApiKeyRow = {
  id: string;
  publicId: string;
  name: string;
  keyHint: string;
  createdByMemberId: string;
  createdByMemberPublicId: string;
  /** Phạm vi đã lưu, không deprecated, đã sắp (spec §12 `OrgApiKey.permissions`). */
  permissions: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Kết quả hàm definer `tenancy_find_org_api_key` (không cần OrgScope). */
export type OrgApiKeyMatch = { orgId: string; id: string; publicId: string };
/** Dòng của nhánh key ở `PrincipalResolver` và `OrgContextMiddleware`: key còn dùng được + người tạo + role HIỆN TẠI. */
export type ActiveKeyAccess = {
  keyId: string;
  keyPublicId: string;
  creatorMemberId: string;
  creatorAuthUserId: string | null;
  creatorRoleId: string;
  creatorSystemKey: SystemRoleKey | null;
  scope: string[];
};

/** Phương thức trừ `findByTokenHash` chạy trong OrgScope của org (RLS). */
export abstract class OrgApiKeyRepository {
  abstract findByTokenHash(
    hashHex: string,
  ): Promise<OrgApiKeyMatch | undefined>;
  /** Key chưa thu hồi, còn hạn theo `now()` (đọc không chờ khoá, §3.15), org chưa xoá mềm; người tạo còn là member (CASCADE). */
  abstract findActiveForAccess(
    publicId: string,
  ): Promise<ActiveKeyAccess | undefined>;
  abstract insert(k: {
    createdByMemberId: string;
    name: string;
    tokenHashHex: string;
    keyHint: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<OrgApiKeyRow>;
  /** Chưa thu hồi và còn hạn theo `clock_timestamp()` (đo SAU khoá org, §3.15; T-11). */
  abstract countActiveForMember(memberId: string): Promise<number>;
  abstract findByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined>;
  abstract lockByPublicId(publicId: string): Promise<OrgApiKeyRow | undefined>;
  /** `revoked_at = clock_timestamp()` khi còn NULL; `undefined` khi đã thu hồi. */
  abstract revoke(id: string): Promise<OrgApiKeyRow | undefined>;
  /** Xoá mềm org (spec §9.4): mọi key chưa thu hồi; không event riêng (§14.1). */
  abstract revokeAll(): Promise<void>;
  /** Key chưa thu hồi của một member (event `CREATOR_REMOVED` trước câu xoá member, §14.1). */
  abstract unrevokedOfMember(
    memberId: string,
  ): Promise<{ publicId: string; version: number }[]>;
  abstract list(q: {
    memberId?: string;
    limit: number;
    offset: number;
  }): Promise<OrgApiKeyRow[]>;
  abstract countUpTo(
    memberId: string | undefined,
    cap: number,
  ): Promise<number>;
}
