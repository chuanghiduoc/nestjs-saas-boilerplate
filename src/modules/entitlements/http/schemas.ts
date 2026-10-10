import { z } from 'zod';
import type { AdminView } from '../application/admin-entitlements.query.js';
import type { EntitlementSnapshot } from '../application/entitlements.service.js';
import { PLAN_SOURCES, REASON_MAX_LENGTH } from '../constants.js';
import {
  OVERRIDE_STATUSES,
  QUOTA_STATES,
  VALUE_SOURCES,
  overrideStatus,
  quotaState,
  resolveEffective,
  type EffectiveValue,
  type Limit,
} from '../domain/effective-value.js';
import {
  RESET_PERIODS,
  type FeatureEntry,
  type MergedFeatures,
} from '../domain/feature-catalogue.js';
import { isReason } from '../domain/override.js';
import type { PlanCatalogue } from '../domain/plan-catalogue.js';
import type { OverrideRow } from '../ports/override.repository.js';
import type { CurrentUsage } from '../ports/usage-counter.repository.js';

const iso = z.iso.datetime();
const source = z.enum(VALUE_SOURCES);
/** `limit` là `null` khi không giới hạn: `UNLIMITED` (Symbol) không bao giờ tới JSON (Review Focus 4). */
const numeric = { unlimited: z.boolean(), limit: z.int().min(0).nullable() };
const FlagItem = z.object({
  key: z.string(),
  kind: z.literal('FLAG'),
  enabled: z.boolean(),
  source,
  overrideExpiresAt: iso.nullable(),
});
const LimitItem = z.object({
  key: z.string(),
  kind: z.literal('LIMIT'),
  ...numeric,
  source,
  overrideExpiresAt: iso.nullable(),
});
const QuotaItem = z.object({
  key: z.string(),
  kind: z.literal('QUOTA'),
  resetPeriod: z.enum(RESET_PERIODS),
  ...numeric,
  used: z.int().min(0),
  state: z.enum(QUOTA_STATES),
  periodStart: iso.nullable(),
  periodEnd: iso.nullable(),
  source,
  overrideExpiresAt: iso.nullable(),
});
/**
 * Spec §12.1: không trả `plan_source_ref`, `plan_reason` (dữ liệu nội bộ của billing/nhân viên); LIMIT không có `used` (module
 * chủ đếm). QUOTA mang `used`/`state` (suy ra, spec §9.4) và kỳ hiện tại (`null` với kỳ NONE); `overrideExpiresAt` là hạn của override đang thắng (4C).
 */
export const OrgEntitlementsResponse = z.object({
  plan: z.object({
    key: z.string(),
    source: z.enum(PLAN_SOURCES),
    assignedAt: iso,
  }),
  features: z.array(
    z.discriminatedUnion('kind', [FlagItem, LimitItem, QuotaItem]),
  ),
});
export type OrgEntitlementsResponse = z.infer<typeof OrgEntitlementsResponse>;
type Item = OrgEntitlementsResponse['features'][number];

function numericOf(limit: Limit): { unlimited: boolean; limit: number | null } {
  switch (limit.kind) {
    case 'UNLIMITED':
      return { unlimited: true, limit: null };
    case 'MAX':
      return { unlimited: false, limit: limit.max };
    default: {
      const unknownKind: never = limit;
      throw new Error(
        `unknown limit kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

/** Chỉ khi override còn hạn đang thắng (`source: OVERRIDE`) và có hạn; `null` khi vĩnh viễn hoặc không có override (4C). */
const overrideExpiryOf = (s: EntitlementSnapshot, key: string): string | null =>
  s.overrides.get(key)?.expiresAt?.toISOString() ?? null;

function itemOf(
  key: string,
  v: EffectiveValue,
  usage: CurrentUsage,
  overrideExpiresAt: string | null,
): Item {
  switch (v.kind) {
    case 'FLAG':
      return {
        key,
        kind: 'FLAG',
        enabled: v.enabled,
        source: v.source,
        overrideExpiresAt,
      };
    case 'LIMIT':
      return {
        key,
        kind: 'LIMIT',
        ...numericOf(v.limit),
        source: v.source,
        overrideExpiresAt,
      };
    case 'QUOTA': {
      const used = usage.used.get(key) ?? 0;
      const period =
        v.resetPeriod === 'MONTH'
          ? {
              periodStart: usage.periodStart.toISOString(),
              periodEnd: usage.periodEnd.toISOString(),
            }
          : { periodStart: null, periodEnd: null };
      return {
        key,
        kind: 'QUOTA',
        resetPeriod: v.resetPeriod,
        ...numericOf(v.limit),
        used,
        state: quotaState(v.limit, used),
        ...period,
        source: v.source,
        overrideExpiresAt,
      };
    }
    default: {
      const unknownKind: never = v;
      throw new Error(
        `unknown effective value kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

/** Tính năng deprecated không liệt kê; sắp theo key để response ổn định giữa các pod. */
export function orgEntitlementsOf(
  s: EntitlementSnapshot,
  features: MergedFeatures,
  usage: CurrentUsage,
): OrgEntitlementsResponse {
  return {
    plan: {
      key: s.plan.key,
      source: s.plan.source,
      assignedAt: s.plan.assignedAt.toISOString(),
    },
    features: [...s.features]
      .filter(([key]) => features.get(key)?.deprecated === false)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => itemOf(key, v, usage, overrideExpiryOf(s, key))),
  };
}

/** Lý do của nhân viên (spec §12.2): trim rồi 1–500 code point, cùng luật `CHECK` của DB (Review Focus 2). */
const reasonText = z
  .string()
  .trim()
  .refine(isReason, {
    message: `must be 1–${REASON_MAX_LENGTH} characters after trimming`,
  });
export const PutPlanBody = z
  .object({ planKey: z.string().min(1), reason: reasonText })
  .strict();
/** Nhiều hơn 3 chữ số thập phân của giây (dưới mili giây). */
const SUB_MILLISECOND = /\.\d{4,}Z$/;
/**
 * Phán quyết controller (4C batch 3): `expiresAt` của nhân viên tới mili giây hoặc thô hơn, nên mọi giá trị lưu là mili giây
 * tròn và `Date` của JS biểu diễn đúng nó (câu snapshot vẫn làm tròn lên tới ms, lớp phòng thủ thứ hai). `precision: 3` của
 * zod đòi ĐÚNG 3 chữ số (từ chối `…:00Z`), nên kiểm bằng refine.
 */
const expiresAtInput = iso.refine((s) => !SUB_MILLISECOND.test(s), {
  message: 'expiresAt has at most millisecond precision',
});
const overrideCommon = {
  reason: reasonText,
  expiresAt: expiresAtInput.nullable(),
};
/** `{ enabled }` cho FLAG hoặc `{ limit }` cho LIMIT/QUOTA (`null` = không giới hạn); `kind`/`minimum` kiểm ở service. */
export const PutOverrideBody = z.union([
  z.object({ enabled: z.boolean(), ...overrideCommon }).strict(),
  z.object({ limit: z.int().min(0).nullable(), ...overrideCommon }).strict(),
]);
/** R-X31: xoá override là thao tác của nhân viên có lý do, vào event audit `override.removed`. */
export const DeleteOverrideBody = z.object({ reason: reasonText }).strict();

/** Mục của view admin: đúng mục của tenant, kể cả `used`/`state`/kỳ (review 4C Spec-I2: nhân viên thấy `OVER_LIMIT`). */
const AdminFeatureItem = z.discriminatedUnion('kind', [
  FlagItem,
  LimitItem,
  QuotaItem,
]);
const QuotaConfigItem = z.object({
  key: z.string(),
  kind: z.literal('QUOTA'),
  resetPeriod: z.enum(RESET_PERIODS),
  ...numeric,
  source,
  overrideExpiresAt: iso.nullable(),
});
/** Giá trị của gói trong catalogue (không org, không usage). */
const PlanFeatureItem = z.discriminatedUnion('kind', [
  FlagItem,
  LimitItem,
  QuotaConfigItem,
]);
type PlanFeatureItem = z.infer<typeof PlanFeatureItem>;
const overrideMeta = {
  feature: z.string(),
  reason: z.string(),
  expiresAt: iso.nullable(),
  status: z.enum(OVERRIDE_STATUSES),
  updatedAt: iso,
};
const AdminOverrideItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('FLAG'), enabled: z.boolean(), ...overrideMeta }),
  z.object({ kind: z.literal('LIMIT'), ...numeric, ...overrideMeta }),
  z.object({ kind: z.literal('QUOTA'), ...numeric, ...overrideMeta }),
]);
type AdminOverrideItem = z.infer<typeof AdminOverrideItem>;
/** Spec §12.2: như tenant + phần nội bộ + mọi override kể cả hết hạn. `lastBillingSeq` là BIGINT → chuỗi. */
export const AdminOrgEntitlementsResponse = z.object({
  orgId: z.uuid(),
  version: z.int().min(1),
  plan: z.object({
    key: z.string(),
    source: z.enum(PLAN_SOURCES),
    sourceRef: z.string().nullable(),
    reason: z.string().nullable(),
    assignedAt: iso,
  }),
  lastBillingSeq: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
  features: z.array(AdminFeatureItem),
  overrides: z.array(AdminOverrideItem),
});
export type AdminOrgEntitlementsResponse = z.infer<
  typeof AdminOrgEntitlementsResponse
>;
export const AdminPlansResponse = z.object({
  defaultPlan: z.string(),
  plans: z.array(
    z.object({
      key: z.string(),
      retired: z.boolean(),
      default: z.boolean(),
      features: z.array(PlanFeatureItem),
    }),
  ),
});
export type AdminPlansResponse = z.infer<typeof AdminPlansResponse>;

function planItemOf(key: string, v: EffectiveValue): PlanFeatureItem {
  switch (v.kind) {
    case 'FLAG':
      return {
        key,
        kind: 'FLAG',
        enabled: v.enabled,
        source: v.source,
        overrideExpiresAt: null,
      };
    case 'LIMIT':
      return {
        key,
        kind: 'LIMIT',
        ...numericOf(v.limit),
        source: v.source,
        overrideExpiresAt: null,
      };
    case 'QUOTA':
      return {
        key,
        kind: 'QUOTA',
        resetPeriod: v.resetPeriod,
        ...numericOf(v.limit),
        source: v.source,
        overrideExpiresAt: null,
      };
    default: {
      const unknownKind: never = v;
      throw new Error(
        `unknown effective value kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

const numericOfValue = (
  limit: number | null,
): { unlimited: boolean; limit: number | null } =>
  limit === null
    ? { unlimited: true, limit: null }
    : { unlimited: false, limit };

/** `kind` lấy từ catalogue của code (trigger của DB đã bảo đảm giá trị khớp kind); `status` theo `now()` của DB (biên `>`). */
function overrideItemOf(
  o: OverrideRow,
  f: FeatureEntry,
  now: Date,
): AdminOverrideItem {
  const meta = {
    feature: o.featureKey,
    reason: o.reason,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    status: overrideStatus(o.expiresAt, now),
    updatedAt: o.updatedAt.toISOString(),
  };
  switch (f.kind) {
    case 'FLAG':
      if (o.flagValue === null)
        throw new Error(
          `the FLAG override of "${o.featureKey}" has no flag value (org_entitlement_overrides_value_ck violated?)`,
        );
      return { kind: 'FLAG', enabled: o.flagValue, ...meta };
    case 'LIMIT':
      return { kind: 'LIMIT', ...numericOfValue(o.limitValue), ...meta };
    case 'QUOTA':
      return { kind: 'QUOTA', ...numericOfValue(o.limitValue), ...meta };
    default: {
      const unknownKind: never = f;
      throw new Error(
        `unknown feature kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

export function adminEntitlementsOf(
  orgId: string,
  view: AdminView,
  features: MergedFeatures,
): AdminOrgEntitlementsResponse {
  const { snapshot: s, root } = view;
  return {
    orgId,
    version: root.version,
    plan: {
      key: s.plan.key,
      source: s.plan.source,
      sourceRef: root.sourceRef,
      reason: root.reason,
      assignedAt: s.plan.assignedAt.toISOString(),
    },
    lastBillingSeq: root.lastBillingSeq?.toString() ?? null,
    // Cùng bộ lọc, thứ tự và mục với `orgEntitlementsOf` của tenant.
    features: orgEntitlementsOf(s, features, view.usage).features,
    overrides: view.overrides.flatMap((o) => {
      const f = features.get(o.featureKey);
      return f ? [overrideItemOf(o, f, root.now)] : [];
    }),
  };
}

/** Giá trị gói không có override, nên mốc giờ của `resolveEffective` (chỉ dùng cho hạn override) không tham gia. */
const NO_OVERRIDE_CLOCK = new Date(0);

export function adminPlansOf(
  plans: PlanCatalogue,
  features: MergedFeatures,
): AdminPlansResponse {
  const active = [...features.values()]
    .filter((f) => !f.deprecated)
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    defaultPlan: plans.defaultPlan,
    plans: [...plans.plans.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((p) => ({
        key: p.key,
        retired: p.retired,
        default: p.key === plans.defaultPlan,
        features: active.map((f) =>
          planItemOf(
            f.key,
            resolveEffective(
              f,
              p.values.get(f.key),
              undefined,
              NO_OVERRIDE_CLOCK,
            ),
          ),
        ),
      })),
  };
}
