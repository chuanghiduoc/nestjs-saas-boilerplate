import { z } from 'zod';
import { defineEvent } from '../../core/events/index.js';
import { PLAN_SOURCES } from './constants.js';

/** Aggregate của mọi event về gói/override (spec §13.1): id = orgId, version = `org_entitlements.version`. */
export const ORG_ENTITLEMENT_AGGREGATE = 'org_entitlement';

/**
 * Spec §13.1: chỉ id/key, không PII, không văn bản tự do (`reason` của nhân viên KHÔNG vào event). Cờ `audit: true`,
 * `webhook: false` (R-X3, S4-D20): 6.0 thêm vào đây khi merge sau 4A (6.0 liệt kê file này ở bảng "sửa code của plan trước").
 */
export const PlanChangedEvent = defineEvent({
  type: 'entitlements.plan.changed',
  version: 1,
  schema: z.object({
    orgId: z.uuid(),
    fromPlan: z.string().nullable(),
    toPlan: z.string(),
    cause: z.enum(PLAN_SOURCES),
    causeRef: z.string().nullable(),
  }),
});
