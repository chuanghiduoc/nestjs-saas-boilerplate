/**
 * Participant xoá cứng org `integrations` (spec SP6 §8.3 "Xoá cứng org", R-X5 order 120): con trước cha, trong transaction
 * purge và OrgScope của org. Hai bảng partitioned xoá qua bảng cha (RLS của cha áp cho mọi partition). Không `CASCADE`:
 * thiếu câu `webhook_deliveries` thì câu `webhook_messages` lỗi `23001` (FK partitioned → partitioned). Delivery không có FK
 * tới endpoint (R-X33), nên "không dòng mồ côi" do test purge X-3 (Task 15) khẳng định từng bảng về 0 dòng.
 */
export const INTEGRATIONS_PURGE_STATEMENTS: readonly string[] = [
  'DELETE FROM webhook_deliveries WHERE org_id = app_current_org()',
  'DELETE FROM webhook_messages WHERE org_id = app_current_org()',
  'DELETE FROM webhook_endpoint_event_types WHERE org_id = app_current_org()',
  'DELETE FROM webhook_endpoint_secrets WHERE org_id = app_current_org()',
  'DELETE FROM webhook_endpoints WHERE org_id = app_current_org()',
];
