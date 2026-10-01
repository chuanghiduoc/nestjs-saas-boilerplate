export type OrgRow = {
  id: string;
  name: string;
  version: number;
  deletedAt: Date | null;
  purgeAfter: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
/** Một dòng của `tenancy_list_user_orgs` (spec SP3 §6.14). */
export type UserOrgRow = {
  orgId: string;
  orgName: string;
  orgDeletedAt: Date | null;
  orgPurgeAfter: Date | null;
  memberPublicId: string;
  rolePublicId: string;
  roleSystemKey: string | null;
  roleName: string | null;
  joinedAt: Date;
};

/** Phương thức "Current" chạy trong OrgScope của org (RLS); hàm definer chạy ở mọi context. */
export abstract class OrgRepository {
  abstract insertCurrent(o: {
    name: string;
    createdByUserId: string;
  }): Promise<OrgRow>;
  abstract readCurrent(): Promise<OrgRow | undefined>;
  abstract lockCurrent(): Promise<OrgRow | undefined>;
  /** `clock_timestamp()` — gọi SAU khi có khoá (spec SP3 §3.15; `now()` là giờ bắt đầu transaction). */
  abstract clockNow(): Promise<Date>;
  abstract rename(name: string): Promise<OrgRow>;
  abstract softDelete(graceSec: number): Promise<OrgRow>;
  abstract restore(): Promise<OrgRow>;
  /** `created_by_user_id = NULL` khi đang trỏ tới user; `true` nếu có dòng đổi (version tăng). */
  abstract detachCreator(userId: string): Promise<boolean>;
  abstract purgeCurrent(): Promise<void>;
  abstract listForUser(
    userId: string,
    includeDeleted: boolean,
    limit: number,
    offset: number,
  ): Promise<UserOrgRow[]>;
  abstract countForUser(
    userId: string,
    includeDeleted: boolean,
  ): Promise<number>;
  abstract countCreatedBy(userId: string): Promise<number>;
  abstract soleOwnerOrgs(userId: string): Promise<string[]>;
  abstract relatedOrgIds(userId: string): Promise<string[]>;
  abstract dueForPurge(after: string, limit: number): Promise<string[]>;
  /** M7: mọi membership của user, kể cả ở org xoá mềm (hàm definer `tenancy_count_user_memberships`). */
  abstract countMembershipsForUser(userId: string): Promise<number>;
}
