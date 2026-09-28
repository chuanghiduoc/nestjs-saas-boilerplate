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
export const DEFINER_FUNCTIONS: readonly string[] = [...DEFINER_FUNCTIONS_3A];
export const DEFINER_READ_TABLES: readonly string[] = [
  ...DEFINER_READ_TABLES_3A,
];
export const TENANCY_TENANT_TABLES: readonly string[] = [
  ...TENANCY_TENANT_TABLES_3A,
];
