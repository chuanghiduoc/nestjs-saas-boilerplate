import type { FieldError } from '../../../core/errors/index.js';
import { ENTITLEMENT_VALUE_MAX, REASON_MAX_LENGTH } from '../constants.js';
import type { FeatureEntry } from './feature-catalogue.js';

/** Giá trị nhân viên gửi (spec §12.2): `{ enabled }` cho FLAG, `{ limit }` cho LIMIT/QUOTA (`null` = không giới hạn). */
export type OverrideRequest =
  { readonly enabled: boolean } | { readonly limit: number | null };
/** Giá trị đã khớp `kind`: cũng là `data.value` của `entitlements.override.set` (spec §13.1). */
export type OverrideValue =
  | { readonly kind: 'FLAG'; readonly enabled: boolean }
  | { readonly kind: 'LIMIT' | 'QUOTA'; readonly limit: number | null };
export type OverrideDecision =
  | { readonly ok: true; readonly value: OverrideValue }
  | { readonly ok: false; readonly problem: FieldError };
/** Trạng thái đang lưu của một override, đủ để so với trạng thái yêu cầu. */
export type StoredOverride = {
  readonly flagValue: boolean | null;
  readonly limitValue: number | null;
  readonly reason: string;
  readonly expiresAt: Date | null;
};

/** Code point như `char_length` của `CHECK` (một emoji là 1, không phải 2 đơn vị UTF-16). */
const codePoints = (s: string): number => Array.from(s).length;

/**
 * Cùng luật với `org_entitlement_overrides_reason_ck` và `org_entitlements_reason_ck`: đã trim, 1–500 code point. `trim`
 * của JS cắt rộng hơn `btrim` của Postgres (chỉ dấu cách), nên chuỗi thoả hàm này luôn thoả `CHECK`.
 */
export const isReason = (r: string): boolean =>
  r === r.trim() && codePoints(r) >= 1 && codePoints(r) <= REASON_MAX_LENGTH;

const refuse = (
  path: string,
  code: string,
  message: string,
): OverrideDecision => ({ ok: false, problem: { path, code, message } });

/**
 * Khớp giá trị gửi lên với `kind` và `minimum` của tính năng (spec §12.2; `minimum` chỉ ở code, S4-D2). Hàm thuần, `switch`
 * vét cạn. Sai `kind` báo ở chính trường đã gửi (`limit` cho FLAG, `enabled` cho LIMIT/QUOTA).
 */
export function decideOverrideValue(
  feature: FeatureEntry,
  input: OverrideRequest,
): OverrideDecision {
  switch (feature.kind) {
    case 'FLAG':
      if (!('enabled' in input))
        return refuse(
          'limit',
          'invalid_value',
          `"${feature.key}" is a FLAG: send enabled, not limit`,
        );
      return { ok: true, value: { kind: 'FLAG', enabled: input.enabled } };
    case 'LIMIT':
    case 'QUOTA': {
      if (!('limit' in input))
        return refuse(
          'enabled',
          'invalid_value',
          `"${feature.key}" is a ${feature.kind}: send limit, not enabled`,
        );
      const { limit } = input;
      if (limit !== null) {
        if (!Number.isSafeInteger(limit) || limit > ENTITLEMENT_VALUE_MAX)
          return refuse(
            'limit',
            'invalid_value',
            `limit must be null (unlimited) or an integer up to ${ENTITLEMENT_VALUE_MAX}`,
          );
        if (limit < feature.minimum)
          return refuse(
            'limit',
            'too_small',
            `limit must be at least ${feature.minimum} for "${feature.key}"`,
          );
      }
      return { ok: true, value: { kind: feature.kind, limit } };
    }
    default: {
      const unknownKind: never = feature;
      throw new Error(
        `unknown feature kind ${String(Reflect.get(unknownKind, 'kind'))}`,
      );
    }
  }
}

/** Dòng đang lưu đúng bằng (giá trị, lý do, hạn) yêu cầu: PUT lặp lại không ghi, không tăng version, không event (RFC 9110 §13.1.1). */
export function sameOverride(
  stored: StoredOverride,
  value: OverrideValue,
  reason: string,
  expiresAt: Date | null,
): boolean {
  const flag = value.kind === 'FLAG' ? value.enabled : null;
  const limit = value.kind === 'FLAG' ? null : value.limit;
  const sameExpiry =
    stored.expiresAt === null
      ? expiresAt === null
      : expiresAt !== null &&
        stored.expiresAt.getTime() === expiresAt.getTime();
  return (
    stored.flagValue === flag &&
    stored.limitValue === limit &&
    stored.reason === reason &&
    sameExpiry
  );
}
