import { z } from 'zod';
import { ORG_NAME_MAX_LENGTH } from '../constants.js';

export const ORG_STATES = ['ACTIVE', 'DELETED'] as const;
export type OrgState = (typeof ORG_STATES)[number];
export type OrgEvent = 'SOFT_DELETE' | 'RESTORE' | 'PURGE';
export type OrgTransition =
  | { ok: true; to: 'ACTIVE' | 'DELETED' | 'PURGED' }
  | {
      ok: false;
      reason: 'NOT_ACTIVE' | 'NOT_DELETED' | 'GRACE_EXPIRED' | 'NOT_DUE';
    };

/** DB giữ hai cột thời gian có CHECK (không cột trạng thái trùng thông tin); domain suy trạng thái. */
export const orgStateOf = (row: { deletedAt: Date | null }): OrgState =>
  row.deletedAt === null ? 'ACTIVE' : 'DELETED';

/**
 * Spec §9.4: `now` là `clock_timestamp()` đọc SAU khi đã khoá dòng org (spec §3.15, T-13, T-29), không `now()` của
 * transaction. Khôi phục đúng lúc `purge_after` là quá hạn (so `>`), xoá cứng đúng lúc đó là tới hạn (`<=`).
 */
export function transitionOrg(
  state: OrgState,
  event: OrgEvent,
  ctx: { now: Date; purgeAfter: Date | null },
): OrgTransition {
  switch (state) {
    case 'ACTIVE':
      switch (event) {
        case 'SOFT_DELETE':
          return { ok: true, to: 'DELETED' };
        case 'RESTORE':
        case 'PURGE':
          return { ok: false, reason: 'NOT_DELETED' };
        default:
          return unknownEvent(event);
      }
    case 'DELETED': {
      if (ctx.purgeAfter === null)
        throw new Error(
          'a DELETED organization must have purge_after (organizations_deleted_pair_ck)',
        );
      const due = ctx.purgeAfter.getTime() <= ctx.now.getTime();
      switch (event) {
        case 'SOFT_DELETE':
          return { ok: false, reason: 'NOT_ACTIVE' };
        case 'RESTORE':
          return due
            ? { ok: false, reason: 'GRACE_EXPIRED' }
            : { ok: true, to: 'ACTIVE' };
        case 'PURGE':
          return due
            ? { ok: true, to: 'PURGED' }
            : { ok: false, reason: 'NOT_DUE' };
        default:
          return unknownEvent(event);
      }
    }
    default: {
      const unknown: never = state;
      throw new Error(`unknown organization state ${String(unknown)}`);
    }
  }
}
function unknownEvent(event: never): never {
  throw new Error(`unknown organization event ${String(event)}`);
}

/**
 * Tên org: không khoảng trắng đầu/cuối (chặt hơn `btrim` của CHECK: cả NBSP, tab), 1–`ORG_NAME_MAX_LENGTH` CODE POINT
 * (cùng cách đếm với `char_length` của CHECK `organizations_name_ck`; `z.string().max` đếm UTF-16 sẽ từ chối tên
 * emoji mà DB nhận — Review Focus 1).
 */
export const orgName = z
  .string()
  .refine((s) => s === s.trim(), 'must not start or end with whitespace')
  .refine((s) => {
    // Cố ý đếm code point (không grapheme như `Intl.Segmenter`): phải khớp `char_length` của Postgres.
    const n = Array.from(s).length;
    return n >= 1 && n <= ORG_NAME_MAX_LENGTH;
  }, `must be 1 to ${ORG_NAME_MAX_LENGTH} characters`);
