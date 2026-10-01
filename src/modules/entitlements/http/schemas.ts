import { z } from 'zod';
import type { EntitlementSnapshot } from '../application/entitlements.service.js';
import { PLAN_SOURCES } from '../constants.js';
import {
  VALUE_SOURCES,
  type EffectiveValue,
  type Limit,
} from '../domain/effective-value.js';
import {
  RESET_PERIODS,
  type MergedFeatures,
} from '../domain/feature-catalogue.js';

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
  source,
  overrideExpiresAt: iso.nullable(),
});
/**
 * Spec §12.1: không trả `plan_source_ref`, `plan_reason` (dữ liệu nội bộ của billing/nhân viên); LIMIT không có `used` (module
 * chủ đếm). 4B thêm `used`/`state`/`periodStart`/`periodEnd` cho QUOTA; 4C điền `overrideExpiresAt`.
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

function itemOf(key: string, v: EffectiveValue): Item {
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

/** Tính năng deprecated không liệt kê; sắp theo key để response ổn định giữa các pod. */
export function orgEntitlementsOf(
  s: EntitlementSnapshot,
  features: MergedFeatures,
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
      .map(([key, v]) => itemOf(key, v)),
  };
}
