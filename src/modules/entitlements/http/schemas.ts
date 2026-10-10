import { z } from 'zod';
import type { EntitlementSnapshot } from '../application/entitlements.service.js';
import { PLAN_SOURCES } from '../constants.js';
import {
  QUOTA_STATES,
  VALUE_SOURCES,
  quotaState,
  type EffectiveValue,
  type Limit,
} from '../domain/effective-value.js';
import {
  RESET_PERIODS,
  type MergedFeatures,
} from '../domain/feature-catalogue.js';
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
