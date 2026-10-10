/**
 * Xoá cứng dòng entitlements của MỘT org (spec SP4 §13.2), chạy trong OrgScope của org đó (RLS). Dùng chung cho participant
 * purge (`order = 100`) và helper seed của test (`seedOrg().dispose()`, `purgeOrgs`) để hai nơi không lệch.
 * Câu đầu khoá dòng gốc `FOR UPDATE` (ngoại lệ có tên của spec §3.6, review 4C C2): mọi người ghi (gán gói, ghi override)
 * khoá gốc rồi mới chạm dòng con; purge mà xoá dòng con trước rồi mới tới gốc thì tạo chu trình `40P01` với một nhân viên
 * đang sửa override có sẵn (đã tái hiện trên PG 18.6). Khoá gốc trước: người ghi đã giữ gốc thì purge chờ rồi xoá cả dòng
 * vừa commit; purge giữ gốc trước thì người ghi chờ rồi thấy 0 dòng (404 / `EntitlementsRowMissingError` / 23503 với
 * consume). Sau đó con trước cha; không `CASCADE`: thiếu một bảng thì câu cuối lỗi `23001` (FK RESTRICT).
 */
export const ENTITLEMENTS_PURGE_STATEMENTS: readonly string[] = [
  'SELECT 1 FROM org_entitlements WHERE org_id = app_current_org() FOR UPDATE',
  'DELETE FROM usage_counters WHERE org_id = app_current_org()',
  'DELETE FROM org_entitlement_overrides WHERE org_id = app_current_org()',
  'DELETE FROM org_entitlements WHERE org_id = app_current_org()',
];
