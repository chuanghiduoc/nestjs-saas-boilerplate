/** `pg_try_advisory_xact_lock` của `audit_partitions_maintain` (spec §6.7; 6002 là webhook, 6900/6901 là fixture 6.0). */
export const AUDIT_PARTITIONS_LOCK_KEY = 6001n;
/** Sàn retention viết cứng trong hàm bảo trì (spec §11.3, rulings C1). */
export const AUDIT_RETENTION_MIN_MONTHS = 6;
export const AUDIT_RETENTION_MAX_MONTHS = 120;
export const AUDIT_PREMAKE_MAX_MONTHS = 12;
/** Trần độ dài của actor_id, target_type, target_id, correlation_id, causation_id (spec §6.4). */
export const AUDIT_TEXT_MAX_LENGTH = 255;
/** Cùng regex với `<bảng>_action_ck` và TYPE_PATTERN của `defineEvent`. */
export const AUDIT_ACTION_PATTERN =
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** Bảng partitioned của 6B, theo thứ tự hàm bảo trì xử lý. */
export const AUDIT_TABLES = ['audit_logs', 'platform_audit_logs'] as const;
/** Postgres timestamptz: năm ngoài [1, 9999] là 22008 (bài học 6C). */
export const TIMESTAMPTZ_MIN_YEAR = 1;
export const TIMESTAMPTZ_MAX_YEAR = 9999;
