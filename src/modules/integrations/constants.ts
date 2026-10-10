import type { EventActor } from '../../core/events/index.js';

/**
 * Hằng định dạng của 6C (spec SP6 §11.4 "Hằng định dạng", §6.5, §6.7). Migration `…_webhooks` viết cứng cùng giá trị;
 * `constants-vs-migration.spec.ts` (Task 5) so hai bên.
 */
export const WEBHOOK_SECRET_BYTES = 32;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_URL_MIN_LENGTH = 10;
export const WEBHOOK_URL_MAX_LENGTH = 2048;
export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 500;
/**
 * Trần cứng số event type của một endpoint (M7): `.max()` của schema HTTP và `maxItems` của OpenAPI dùng hằng này, nên
 * `openapi.json` không phụ thuộc env của máy export. `INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT` chỉ hạ trần lúc chạy (service kiểm).
 */
export const WEBHOOK_EVENT_TYPES_MAX = 50;
/** Cùng regex với `webhook_event_types_type_ck` và `TYPE_PATTERN` của `defineEvent`. */
export const WEBHOOK_EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** `pg_try_advisory_xact_lock` của `webhook_partitions_maintain` (spec §6.7; 6001 là audit, 6900/6901 là fixture 6.0). */
export const WEBHOOK_PARTITIONS_LOCK_KEY = 6002n;
/** Sàn retention viết cứng trong hàm bảo trì. */
export const WEBHOOK_RETENTION_MIN_MONTHS = 1;
/** Registry order của participant xoá cứng (R-X5, addendum 3D §A4). */
export const INTEGRATIONS_PURGE_ORDER = 120;
/** Tên provider của `ResiliencePolicies` và tên queue (spec §5.3 hàng `core/resilience`, §10). Hằng có tên, không theo tenant. */
export const WEBHOOKS_OUT = 'webhooks-out';
/** Breaker theo provider sẽ gộp endpoint của mọi khách (S6-A30): ngưỡng không bao giờ đạt. */
export const WEBHOOK_BREAKER_NEVER = Number.MAX_SAFE_INTEGER;
/**
 * Job tới sớm hơn `next_attempt_at` quá mức này là job trùng (sweep, kill switch) hoặc lệch đồng hồ Redis/DB: claim là no-op,
 * job đúng hạn của chính lần hẹn đó vẫn chạy (R6C-1). Một giây lớn hơn độ lệch đồng hồ bình thường giữa hai máy NTP.
 */
export const CLAIM_CLOCK_SKEW_MS = 1000;
/**
 * Khoảng lease phải chừa ngoài timeout của request (I1, review bảo mật 6C): claim → ký → DNS/connect → … → ghi kết quả. Timeout
 * chạm lease thì lease hết giữa lúc request còn bay: sweep hẹn lại, trần in-flight bị vượt, delivery gửi hai lần.
 */
export const WEBHOOK_LEASE_MARGIN_MS = 5000;
/**
 * Năm nhỏ nhất `timestamptz` của Postgres nhận (năm 0 không tồn tại: `0000-…` là lỗi 22008). Regex ISO và `Date` của JS đều
 * nhận năm 0000, nên mốc thời gian từ client (cursor, `since`) phải kiểm năm trước khi tới SQL (review cuối 6C m-1, m-2).
 */
export const TIMESTAMPTZ_MIN_YEAR = 1;
/** `user-agent` = `<APP_SERVICE_NAME>` + hậu tố này (spec §11.4 `WEBHOOK_USER_AGENT`). */
export const WEBHOOK_USER_AGENT_SUFFIX = '-webhooks/1';
/** Actor của event do hệ thống gây ra (tự tắt endpoint, hết lịch). */
export const INTEGRATIONS_SYSTEM_ACTOR: EventActor = {
  type: 'system',
  id: 'integrations.deliver',
};
export const ENDPOINT_AGGREGATE = 'webhook_endpoint';
export const DELIVERY_AGGREGATE = 'webhook_delivery';
