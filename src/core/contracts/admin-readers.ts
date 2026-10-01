/**
 * Hợp đồng đọc số liệu cho module admin (spec SP6 §5.2, R-X16, S6-A52). Chỉ `abstract class` làm token DI, không import gì,
 * không provider nào ở core. files (6A) và integrations (6C) cài bằng module `@Global()` của mình trong `forApi()`; admin (6D)
 * inject `@Optional()`: module bị tắt → không có provider → trường tương ứng của `AdminOrg` là `null`. Admin không import
 * `index.ts` của files/integrations. Cả hai phương thức chạy trong `OrgScope` của caller.
 */
export abstract class FileUsageReader {
  /** Tổng byte đang lưu của org hiện tại (gốc + `clean` + thumbnail + bản public, spec SP6 §6.3). */
  abstract storageUsedBytes(): Promise<number>;
}

export abstract class WebhookStatsReader {
  /** Số webhook endpoint chưa xoá của org hiện tại. */
  abstract endpointCount(): Promise<number>;
}
