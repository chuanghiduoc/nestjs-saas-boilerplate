import { z } from 'zod';
import {
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
} from '../constants.js';
import type { MergedCatalogue } from './catalogue.js';
import { closure } from './permission-set.js';

/** Đếm CODE POINT (như `char_length` của Postgres), cố ý không đếm grapheme: phải khớp CHECK của DB. */
const codePoints = (s: string): number => Array.from(s).length;

/**
 * Tên role tuỳ biến: không khoảng trắng đầu/cuối (chặt hơn `btrim` của CHECK: cả NBSP, tab), 1–`ROLE_NAME_MAX_LENGTH`
 * CODE POINT, cùng cách đếm với `char_length` của `org_roles_name_ck` (Review Focus 1).
 */
export const roleName = z
  .string()
  .refine((s) => s === s.trim(), 'must not start or end with whitespace')
  .refine(
    (s) => codePoints(s) >= 1 && codePoints(s) <= ROLE_NAME_MAX_LENGTH,
    `must be 1 to ${ROLE_NAME_MAX_LENGTH} characters`,
  );
export const roleDescription = z
  .string()
  .refine(
    (s) => codePoints(s) <= ROLE_DESCRIPTION_MAX_LENGTH,
    `must be at most ${ROLE_DESCRIPTION_MAX_LENGTH} characters`,
  );

export type CustomRoleSetCheck =
  | { ok: true; permissions: ReadonlySet<string> }
  | {
      ok: false;
      reason:
        | 'UNKNOWN_PERMISSION'
        | 'PERMISSION_NOT_DELEGABLE'
        | 'MISSING_DEPENDENCIES';
      keys: readonly string[];
    };

/**
 * Luật 1 phần "tập mới hợp lệ" (spec SP3 §8.4, PR5, PR6): mọi key có trong catalogue gộp và không deprecated (`manage`/`all`
 * không bao giờ có trong catalogue nên rơi vào đây), không `ownerOnly`, và tập ĐÃ đóng theo `requires` (không tự thêm
 * quyền thiếu). Thứ tự lỗi cố định để client sửa từng lớp. Trigger `org_role_permissions_guard`/`_closed_ck` là lớp cuối.
 */
export function checkCustomRoleSet(
  keys: Iterable<string>,
  merged: MergedCatalogue,
): CustomRoleSetCheck {
  const set = new Set(keys);
  const unknown = [...set]
    .filter((k) => merged.get(k)?.deprecated !== false)
    .sort();
  if (unknown.length)
    return { ok: false, reason: 'UNKNOWN_PERMISSION', keys: unknown };
  const ownerOnly = [...set]
    .filter((k) => merged.get(k)?.ownerOnly === true)
    .sort();
  if (ownerOnly.length)
    return { ok: false, reason: 'PERMISSION_NOT_DELEGABLE', keys: ownerOnly };
  const missing = [...closure(set, merged)].filter((k) => !set.has(k)).sort();
  if (missing.length)
    return { ok: false, reason: 'MISSING_DEPENDENCIES', keys: missing };
  return { ok: true, permissions: set };
}

export const sameSet = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean => a.size === b.size && [...a].every((k) => b.has(k));
