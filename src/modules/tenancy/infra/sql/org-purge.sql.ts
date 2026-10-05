/**
 * Xoá cứng các bảng tenancy của MỘT org, con trước cha (spec SP3 §9.5), chạy trong OrgScope của org đó (RLS). Dùng chung
 * cho job purge (`SqlOrgRepository.purgeCurrent`) và `seedOrg().dispose()` của test để hai nơi không lệch (DB2-N7).
 * Không `CASCADE` từ `organizations`: bảng thiếu ở đây làm câu cuối lỗi `23001` (fail to), không để dòng mồ côi.
 * Plan sau chèn bảng của mình: 3B `org_role_permissions` trước `org_roles`; 3C, 3D bảng của mình trước `org_members`.
 */
export const ORG_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM org_support_grant_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_support_grants WHERE org_id = app_current_org()',
  'DELETE FROM org_api_key_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_api_keys WHERE org_id = app_current_org()',
  'DELETE FROM org_ownership_transfers WHERE org_id = app_current_org()',
  'DELETE FROM org_invite_links WHERE org_id = app_current_org()',
  'DELETE FROM org_invitations WHERE org_id = app_current_org()',
  'DELETE FROM org_members WHERE org_id = app_current_org()',
  'DELETE FROM org_role_permissions WHERE org_id = app_current_org()',
  'DELETE FROM org_roles WHERE org_id = app_current_org()',
  'DELETE FROM organizations WHERE id = app_current_org()',
];
