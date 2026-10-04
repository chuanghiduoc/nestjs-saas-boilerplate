import type { SystemRoleKey } from '../constants.js';

export type SupportGrantRow = {
  id: string;
  publicId: string;
  granteeUserId: string | null;
  granteeUserPublicId: string | null;
  grantedByMemberId: string | null;
  grantedByMemberPublicId: string | null;
  reason: string;
  permissions: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  firstUsedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
/** Dòng của nhánh support ở middleware: grant mở còn hạn của user trong org + role HIỆN TẠI của owner đã cấp (S3-P3). */
export type OpenGrantAccess = {
  grantId: string;
  grantPublicId: string;
  firstUsedAt: Date | null;
  granterSystemKey: SystemRoleKey | null;
  scope: string[];
};

/** Phương thức trừ `granteeOpenGrantOrgs` chạy trong OrgScope của org (RLS). */
export abstract class SupportGrantRepository {
  abstract insert(g: {
    granteeUserId: string;
    grantedByMemberId: string;
    reason: string;
    expiresInSec: number;
    permissions: readonly string[];
  }): Promise<SupportGrantRow>;
  /** `revoked_at = clock_timestamp()` cho grant chưa thu hồi của người nhận trong org hiện tại (cấp lại, SEC-M5, N5-1). */
  abstract revokeOpenForGrantee(
    granteeUserId: string,
  ): Promise<SupportGrantRow[]>;
  abstract findByPublicId(
    publicId: string,
  ): Promise<SupportGrantRow | undefined>;
  abstract lockByPublicId(
    publicId: string,
  ): Promise<SupportGrantRow | undefined>;
  abstract revoke(id: string): Promise<SupportGrantRow | undefined>;
  abstract revokeAll(): Promise<void>;
  abstract list(q: {
    limit: number;
    offset: number;
  }): Promise<SupportGrantRow[]>;
  abstract countUpTo(cap: number): Promise<number>;
  /** Spec §7.1 bước 3.7: không tạo `tenancy_users` (Review Focus 2 của 3A); local/hybrid → theo `auth_user_id`. */
  abstract findOpenForAccess(
    authUserId: string,
  ): Promise<OpenGrantAccess | undefined>;
  /** Bước 3.10 (T-15): `first_used_at` khi còn NULL; `undefined` khi đã ghi. */
  abstract markFirstUse(id: string): Promise<SupportGrantRow | undefined>;
  /** Hàm definer `tenancy_grantee_open_grant_orgs` (không cần OrgScope). */
  abstract granteeOpenGrantOrgs(userId: string): Promise<string[]>;
}
