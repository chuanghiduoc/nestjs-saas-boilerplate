import {
  UNLIMITED,
  type FeatureEntry,
  type NumericValue,
} from './feature-catalogue.js';
import type { PlanValue } from './plan-catalogue.js';

export type Limit =
  | { readonly kind: 'UNLIMITED' }
  | { readonly kind: 'MAX'; readonly max: number };
export const VALUE_SOURCES = ['OVERRIDE', 'PLAN', 'FALLBACK'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];
export type EffectiveValue =
  | {
      readonly kind: 'FLAG';
      readonly enabled: boolean;
      readonly source: ValueSource;
    }
  | {
      readonly kind: 'LIMIT';
      readonly limit: Limit;
      readonly source: ValueSource;
    }
  | {
      readonly kind: 'QUOTA';
      readonly limit: Limit;
      readonly resetPeriod: 'NONE' | 'MONTH';
      readonly source: ValueSource;
    };
/** Dòng override của nhân viên (bảng của 4C): FLAG dùng `flagValue`; LIMIT/QUOTA dùng `limitValue` (NULL = không giới hạn). */
export type OverrideInput = {
  readonly flagValue: boolean | null;
  readonly limitValue: number | null;
  readonly expiresAt: Date | null;
};
export type OverrideStatus = 'ACTIVE' | 'EXPIRED';
export const QUOTA_STATES = ['WITHIN', 'REACHED', 'OVER_LIMIT'] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

/** Giá trị sai kiểu với `kind` tới được lúc chạy (kiểm lúc boot/trigger đã phải chặn): lỗi lập trình, không đoán. */
export class InvalidEntitlementValueError extends Error {
  constructor(
    readonly featureKey: string,
    detail: string,
  ) {
    super(`Invalid entitlement value for "${featureKey}": ${detail}`);
    this.name = 'InvalidEntitlementValueError';
  }
}

/** Hết hạn là suy ra (spec §7.4, S4-D12): hết hạn TẠI ĐÚNG `expires_at`, cùng biên `expires_at > now()` của câu snapshot. */
export const overrideStatus = (
  expiresAt: Date | null,
  now: Date,
): OverrideStatus =>
  expiresAt === null || expiresAt.getTime() > now.getTime()
    ? 'ACTIVE'
    : 'EXPIRED';

export const toLimit = (v: NumericValue): Limit =>
  v === UNLIMITED ? { kind: 'UNLIMITED' } : { kind: 'MAX', max: v.max };

function numeric(
  feature: { readonly key: string; readonly fallback: NumericValue },
  planValue: PlanValue | undefined,
  override: OverrideInput | undefined,
): { limit: Limit; source: ValueSource } {
  if (override) {
    if (override.flagValue !== null)
      throw new InvalidEntitlementValueError(
        feature.key,
        'a numeric override carries a flag value',
      );
    return {
      limit:
        override.limitValue === null
          ? { kind: 'UNLIMITED' }
          : { kind: 'MAX', max: override.limitValue },
      source: 'OVERRIDE',
    };
  }
  if (planValue !== undefined) {
    if (typeof planValue === 'boolean')
      throw new InvalidEntitlementValueError(
        feature.key,
        'the plan gives a boolean to a numeric feature',
      );
    return { limit: toLimit(planValue), source: 'PLAN' };
  }
  return { limit: toLimit(feature.fallback), source: 'FALLBACK' };
}

/** Một luật ưu tiên (S4-D12): override còn hạn > giá trị gói > `fallback`. Hàm thuần, `switch` vét cạn theo `kind`. */
export function resolveEffective(
  feature: FeatureEntry,
  planValue: PlanValue | undefined,
  override: OverrideInput | undefined,
  now: Date,
): EffectiveValue {
  const active =
    override && overrideStatus(override.expiresAt, now) === 'ACTIVE'
      ? override
      : undefined;
  switch (feature.kind) {
    case 'FLAG': {
      if (active) {
        if (active.flagValue === null)
          throw new InvalidEntitlementValueError(
            feature.key,
            'a FLAG override has no flag value',
          );
        return { kind: 'FLAG', enabled: active.flagValue, source: 'OVERRIDE' };
      }
      if (planValue !== undefined) {
        if (typeof planValue !== 'boolean')
          throw new InvalidEntitlementValueError(
            feature.key,
            'the plan gives a number to a FLAG',
          );
        return { kind: 'FLAG', enabled: planValue, source: 'PLAN' };
      }
      return { kind: 'FLAG', enabled: feature.fallback, source: 'FALLBACK' };
    }
    case 'LIMIT':
      return { kind: 'LIMIT', ...numeric(feature, planValue, active) };
    case 'QUOTA':
      return {
        kind: 'QUOTA',
        resetPeriod: feature.resetPeriod,
        ...numeric(feature, planValue, active),
      };
    default: {
      const unknownKind: never = feature;
      throw new InvalidEntitlementValueError(
        String(Reflect.get(unknownKind, 'key')),
        'unknown feature kind',
      );
    }
  }
}

/** Trạng thái hiển thị của quota (spec §9.4), suy ra, không lưu. `used > max` sau khi hạ gói là hợp lệ (S4-D13). */
export function quotaState(limit: Limit, used: number): QuotaState {
  switch (limit.kind) {
    case 'UNLIMITED':
      return 'WITHIN';
    case 'MAX':
      return used < limit.max
        ? 'WITHIN'
        : used === limit.max
          ? 'REACHED'
          : 'OVER_LIMIT';
    default: {
      const unknownKind: never = limit;
      throw new Error(
        `unknown limit kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}
