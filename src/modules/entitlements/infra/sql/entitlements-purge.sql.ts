/**
 * Xoá cứng dòng entitlements của MỘT org, con trước cha (spec SP4 §13.2), chạy trong OrgScope của org đó (RLS). Dùng chung
 * cho participant purge (`order = 100`, Task 11) và helper seed của test (`seedOrg().dispose()`, `purgeOrgs`) để hai nơi
 * không lệch. 4B: `usage_counters` trước dòng gốc; 4C chèn `org_entitlement_overrides` giữa hai câu. Không `CASCADE`:
 * thiếu một bảng thì câu cuối lỗi `23001` (FK RESTRICT), không để dòng mồ côi.
 */
export const ENTITLEMENTS_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM usage_counters WHERE org_id = app_current_org()',
  'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
];
