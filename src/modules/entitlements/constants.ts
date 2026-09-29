/**
 * Hằng định dạng của SP4 (spec §3 mục 4, §14): dùng chung giữa zod và `CHECK` của migration (migration viết cứng cùng giá
 * trị; `schema.spec.ts` so hai phía). Không phải tunable, nên không nằm trong config.
 */
/** 2^53 − 1: số đếm/trần lớn nhất mà JSON số giữ chính xác (`CHECK … BETWEEN 0 AND 9007199254740991`). */
export const ENTITLEMENT_VALUE_MAX = Number.MAX_SAFE_INTEGER;
/** `<module>.<tên>`: `entitlement_features_key_ck`. */
export const FEATURE_KEY_PATTERN =
  /^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,47}$/;
/** `plans_key_ck`. */
export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** `org_entitlements_reason_format_ck` (lý do của nhân viên, đếm code point như `char_length`). */
export const REASON_MAX_LENGTH = 500;
/** `org_entitlements_source_ref_length_ck` (id công khai của subscription SP5, opaque). */
export const SOURCE_REF_MAX_LENGTH = 128;
/** Registry `order` của participant xoá cứng (addendum 3D §A4, R-X5): entitlements = 100, trước tenancy core (1000). */
export const ENTITLEMENTS_PURGE_ORDER = 100;
/** Nguồn gán gói (`org_entitlements_source_ck`): enum, không phải cờ rời (spec §11). */
export const PLAN_SOURCES = ['DEFAULT', 'BILLING', 'PLATFORM_ADMIN'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];
