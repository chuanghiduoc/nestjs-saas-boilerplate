import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { PLAN_SOURCES, REASON_MAX_LENGTH } from './constants.js';
import { isReason } from './domain/override.js';

/**
 * Lý do của nhân viên trong event audit (R-X31, ngoại lệ có tên của A9): văn bản do nhân viên viết, đã trim, 1–500 code
 * point, KHÔNG được chứa PII của khách; tới `audit_logs` (SP6 6B; trước 6B, dòng outbox là bản ghi bền). Mọi event mang nó
 * khai `webhook: false`, nên nó không bao giờ ra ngoài qua webhook.
 */
export const StaffReason = z
  .string()
  .refine(isReason, {
    message: `a staff reason is trimmed and 1–${REASON_MAX_LENGTH} characters`,
  })
  .describe('Staff-authored reason; no customer PII; it reaches audit_logs');

/** Aggregate của mọi event về gói/override (spec §13.1): id = orgId, version = `org_entitlements.version`. */
export const ORG_ENTITLEMENT_AGGREGATE = 'org_entitlement';

/**
 * Spec §13.1: chỉ id/key, không PII; `reason` có đúng khi `cause = 'PLATFORM_ADMIN'` (R-X31; trường tuỳ chọn cộng thêm,
 * envelope cũ không có nó vẫn parse, nên giữ version 1). `audit: true`,
 * `webhook: false` (R-X3, S4-D20): đổi gói vào nhật ký audit của org, không phát ra webhook.
 */
export const PlanChangedEvent = defineEvent({
  type: 'entitlements.plan.changed',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    orgId: z.uuid(),
    fromPlan: z.string().nullable(),
    toPlan: z.string(),
    cause: z.enum(PLAN_SOURCES),
    causeRef: z.string().nullable(),
    reason: StaffReason.optional(),
  }),
});

/** Aggregate của `entitlements.quota.reached` (spec §13.1): id = `usage_counters.id`, version = `usage_counters.version`. */
export const USAGE_COUNTER_AGGREGATE = 'usage_counter';

/**
 * Spec §13.1, S4-D16: phát CÙNG transaction khi một lần tiêu thụ thành công đưa `used` chạm trần (không phát cho lần bị
 * từ chối: lần đó rollback cùng caller và phát mỗi lần là spam). `audit: true`, `webhook: false` (R-X3, S4-D20).
 */
export const QuotaReachedEvent = defineEvent({
  type: 'entitlements.quota.reached',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    orgId: z.uuid(),
    feature: z.string(),
    periodStart: z.iso.datetime().nullable(),
    limit: z.int().min(0),
    used: z.int().min(0),
  }),
});

/** `data.value` của `override.set` (spec §13.1): cùng hình dạng `OverrideValue` của miền. */
const OverrideValueSchema = z.union([
  z.object({ kind: z.literal('FLAG'), enabled: z.boolean() }),
  z.object({
    kind: z.enum(['LIMIT', 'QUOTA']),
    limit: z.int().min(0).nullable(),
  }),
]);

/**
 * Spec §13.1, S4-D12: nhân viên đặt/thay override; aggregate `org_entitlement`, version = `org_entitlements.version` mới.
 * Mang `reason` (R-X31). `audit: true`, `webhook: false` (R-X3, S4-D20). Hết hạn KHÔNG có event (suy ra khi đọc); PUT lặp
 * lại đúng trạng thái không có event.
 */
export const OverrideSetEvent = defineEvent({
  type: 'entitlements.override.set',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    orgId: z.uuid(),
    feature: z.string(),
    value: OverrideValueSchema,
    expiresAt: z.iso.datetime().nullable(),
    reason: StaffReason,
  }),
});

/** Spec §13.1: nhân viên xoá override, kèm lý do (R-X31); `audit: true`, `webhook: false` (R-X3). */
export const OverrideRemovedEvent = defineEvent({
  type: 'entitlements.override.removed',
  version: 1,
  audit: true,
  webhook: false,
  schema: z.object({
    orgId: z.uuid(),
    feature: z.string(),
    reason: StaffReason,
  }),
});
