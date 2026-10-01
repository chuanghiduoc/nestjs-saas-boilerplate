/**
 * Bảng của SP4 theo plan (spec SP4 §7, §20.2 DB-1): test catalog so với HỢP các hằng đang có mặt, để 4B ∥ 4C chỉ xung đột
 * văn bản ở dòng khai báo hằng. Plan sau THÊM hằng của mình, không sửa hằng 4A.
 */
export const ENTITLEMENTS_TENANT_TABLES_4A = ['org_entitlements'] as const;
export const ENTITLEMENTS_GLOBAL_TABLES_4A = [
  'entitlement_features',
  'plans',
] as const;
export const ENTITLEMENTS_TENANT_TABLES: readonly string[] = [
  ...ENTITLEMENTS_TENANT_TABLES_4A,
];
export const ENTITLEMENTS_GLOBAL_TABLES: readonly string[] = [
  ...ENTITLEMENTS_GLOBAL_TABLES_4A,
];
