import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { PLAN_SOURCES } from './constants.js';

/** Aggregate của mọi event về gói/override (spec §13.1): id = orgId, version = `org_entitlements.version`. */
export const ORG_ENTITLEMENT_AGGREGATE = 'org_entitlement';

/**
 * Spec §13.1: chỉ id/key, không PII, không văn bản tự do (`reason` của nhân viên KHÔNG vào event). `audit: true`,
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
