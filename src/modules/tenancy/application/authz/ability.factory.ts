import { Ability } from '@casl/ability';
import {
  UnknownPermissionError,
  type MergedCatalogue,
} from '../../domain/catalogue.js';

/** Sentinel không trùng action/resource nào (regex bắt đầu bằng [a-z]): `manage`/`all` mất nghĩa wildcard (S3-P6, T1). */
export const NO_WILDCARD = '__no_wildcard__';
export type TenancyAbility = Ability<[string, string]>;

/**
 * `Ability` trần của CASL 7.0.1 dựng theo request từ quyền hiệu lực (spec §8.7): rule lấy thẳng `resource`/`action` của
 * catalogue gộp, không parse chuỗi key; không `conditions`/`fields` (Ability trần ném nếu ai đó thêm); không cache.
 * Key lạ → `UnknownPermissionError` (500, log ERROR); key deprecated bị bỏ (U10).
 */
export function buildAbility(
  permissions: readonly string[],
  merged: MergedCatalogue,
): TenancyAbility {
  const rules = permissions.flatMap((k) => {
    const entry = merged.get(k);
    if (!entry) throw new UnknownPermissionError(k);
    return entry.deprecated
      ? []
      : [{ action: entry.action, subject: entry.resource }];
  });
  return new Ability<[string, string]>(rules, {
    anyAction: NO_WILDCARD,
    anySubjectType: NO_WILDCARD,
  });
}
