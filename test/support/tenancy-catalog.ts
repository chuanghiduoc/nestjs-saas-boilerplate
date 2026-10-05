/**
 * Tập tên theo plan (spec SP3 §6.14, §18.1, INT3-3): test so với HỢP các hằng đang có mặt, không so số tuyệt đối, để
 * 3C ∥ 3D chỉ xung đột văn bản ở dòng khai báo hằng. Plan sau THÊM hằng của mình, không sửa hằng 3A.
 */
export const DEFINER_FUNCTIONS_3A = [
  'tenancy_list_user_orgs',
  'tenancy_count_user_orgs',
  'tenancy_count_orgs_created_by',
  'tenancy_user_sole_owner_orgs',
  'tenancy_user_related_org_ids',
  'tenancy_orgs_due_for_purge',
] as const;
export const DEFINER_READ_TABLES_3A = [
  'organizations',
  'org_roles',
  'org_members',
] as const;
/** Bảng tenant của tenancy có policy `<bảng>_tenant TO app_user` (không kể bảng global và bảng gốc). */
export const TENANCY_TENANT_TABLES_3A = ['org_roles', 'org_members'] as const;
/**
 * Hàm nội bộ thuộc `tenancy_definer` (spec SP3 §6.4, §6.6): ba hàm trigger hoãn `SECURITY DEFINER` và hàm khoá advisory
 * theo org. Không ai có `EXECUTE` ngoài owner; `app_owner` có `EXECUTE` trên ba hàm trigger chỉ để `CREATE TRIGGER`.
 */
export const DEFINER_TRIGGER_FUNCTIONS_3A = [
  'tenancy_organizations_bootstrap_ck',
  'tenancy_organizations_restore_owner_ck',
  'tenancy_org_members_last_owner_ck',
] as const;
export const DEFINER_INTERNAL_FUNCTIONS_3A = [
  ...DEFINER_TRIGGER_FUNCTIONS_3A,
  'tenancy_org_lock_key',
] as const;
/** Plan 3B (spec §6.5; bài học Task 13 của 3A): hàm closure hoãn đọc bảng tenant nên là SECURITY DEFINER của tenancy_definer. */
export const DEFINER_READ_TABLES_3B = ['org_role_permissions'] as const;
export const TENANCY_TENANT_TABLES_3B = ['org_role_permissions'] as const;
export const DEFINER_TRIGGER_FUNCTIONS_3B = [
  'tenancy_permission_scope_closed_ck',
] as const;
export const DEFINER_INTERNAL_FUNCTIONS_3B = [
  ...DEFINER_TRIGGER_FUNCTIONS_3B,
] as const;
/**
 * Plan 3C (spec §6.14, §18.1): hai hàm tra token (không cần OrgScope) và hàm đếm membership của M7 (single-org, mọi org
 * kể cả xoá mềm). Hàm definer đọc `org_invitations`, `org_invite_links` qua policy `_definer_read`; `org_members` đã có
 * policy của 3A. `org_ownership_transfers` không có policy definer (không hàm nào đọc nó xuyên org).
 */
export const DEFINER_FUNCTIONS_3C = [
  'tenancy_find_invitation',
  'tenancy_find_invite_link',
  'tenancy_count_user_memberships',
] as const;
export const DEFINER_READ_TABLES_3C = [
  'org_invitations',
  'org_invite_links',
] as const;
export const TENANCY_TENANT_TABLES_3C = [
  'org_invitations',
  'org_invite_links',
  'org_ownership_transfers',
] as const;
/**
 * Plan 3D (spec §6.10–6.11, §6.14, §18.1): tra org key theo hash (không cần OrgScope) và org có grant mở của một grantee
 * (thu hồi khi role nền tảng đổi). Bốn bảng có policy `_definer_read`: hai bảng gốc cho hai hàm trên và hai trigger hoãn,
 * hai bảng nối cho hàm closure dùng chung của 3B (`tenancy_permission_scope_closed_ck`, SECURITY DEFINER của
 * `tenancy_definer`, đọc bảng nối của chính trigger). Hai trigger hoãn grantee/member là SECURITY DEFINER (bài học 3A Task 13).
 */
export const DEFINER_FUNCTIONS_3D = [
  'tenancy_find_org_api_key',
  'tenancy_grantee_open_grant_orgs',
] as const;
export const DEFINER_READ_TABLES_3D = [
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;
export const TENANCY_TENANT_TABLES_3D = [
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;
export const DEFINER_TRIGGER_FUNCTIONS_3D = [
  'tenancy_org_support_grants_grantee_not_member',
  'tenancy_org_members_no_active_support_grant',
] as const;
export const DEFINER_INTERNAL_FUNCTIONS_3D = [
  ...DEFINER_TRIGGER_FUNCTIONS_3D,
] as const;
export const DEFINER_FUNCTIONS: readonly string[] = [
  ...DEFINER_FUNCTIONS_3A,
  ...DEFINER_FUNCTIONS_3C,
  ...DEFINER_FUNCTIONS_3D,
];
export const DEFINER_READ_TABLES: readonly string[] = [
  ...DEFINER_READ_TABLES_3A,
  ...DEFINER_READ_TABLES_3B,
  ...DEFINER_READ_TABLES_3C,
  ...DEFINER_READ_TABLES_3D,
];
export const TENANCY_TENANT_TABLES: readonly string[] = [
  ...TENANCY_TENANT_TABLES_3A,
  ...TENANCY_TENANT_TABLES_3B,
  ...TENANCY_TENANT_TABLES_3C,
  ...TENANCY_TENANT_TABLES_3D,
];
export const DEFINER_TRIGGER_FUNCTIONS: readonly string[] = [
  ...DEFINER_TRIGGER_FUNCTIONS_3A,
  ...DEFINER_TRIGGER_FUNCTIONS_3B,
  ...DEFINER_TRIGGER_FUNCTIONS_3D,
];
export const DEFINER_INTERNAL_FUNCTIONS: readonly string[] = [
  ...DEFINER_INTERNAL_FUNCTIONS_3A,
  ...DEFINER_INTERNAL_FUNCTIONS_3B,
  ...DEFINER_INTERNAL_FUNCTIONS_3D,
];
