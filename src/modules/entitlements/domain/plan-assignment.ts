import type { PlanSource } from '../constants.js';

/** Lệnh gán gói (spec §10.1, R-X1). `DEFAULT` không có trong lệnh công khai: chỉ participant/subscriber/backfill chèn nguồn đó. */
export type AssignmentCause =
  | {
      readonly kind: 'BILLING';
      readonly ref: string;
      readonly sequence: bigint;
    }
  | {
      readonly kind: 'PLATFORM_ADMIN';
      readonly reason: string;
      readonly expectedVersion: number;
    };
export type AssignPlanCommand = {
  readonly planKey: string;
  readonly cause: AssignmentCause;
};
/** Trạng thái hiện tại đọc dưới khoá `FOR NO KEY UPDATE` (spec §10.2 bước 2). */
export type CurrentAssignment = {
  readonly planKey: string;
  readonly source: PlanSource;
  readonly sourceRef: string | null;
  readonly reason: string | null;
  readonly lastBillingSeq: bigint | null;
  readonly version: number;
};
/** Gói đích; `retired` đọc từ DB (cùng nguồn với trigger `org_entitlements_plan_not_retired`), không từ catalogue. */
export type TargetPlan = { readonly key: string; readonly retired: boolean };
export type AssignmentDecision =
  | { readonly kind: 'APPLY' }
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'STALE'; readonly lastBillingSeq: bigint }
  | { readonly kind: 'REJECTED_RETIRED' }
  | { readonly kind: 'VERSION_MISMATCH' };

function settle(
  current: CurrentAssignment,
  target: TargetPlan,
  source: PlanSource,
  ref: string | null,
  reason: string | null,
): AssignmentDecision {
  const samePlan = target.key === current.planKey;
  if (target.retired && !samePlan) return { kind: 'REJECTED_RETIRED' };
  if (
    samePlan &&
    current.source === source &&
    current.sourceRef === ref &&
    current.reason === reason
  )
    return { kind: 'UNCHANGED' };
  return { kind: 'APPLY' };
}

/**
 * Hàm quyết định (spec §10.2 bước 3, S4-D11, R-X18): lệnh mới nhất thắng; billing khẳng định lại gói mỗi kỳ, nên gán tay
 * của nhân viên bị ghi đè ở kỳ trả tiền kế tiếp (APPLY), gia hạn cùng gói cùng subscription là UNCHANGED. `switch` vét cạn.
 * Nhân viên gán lại đúng gói hiện tại với lý do mới là APPLY: lý do được ghi và đi vào event (R-X31, review 4C M1).
 */
export function decideAssignment(
  current: CurrentAssignment,
  target: TargetPlan,
  cause: AssignmentCause,
): AssignmentDecision {
  switch (cause.kind) {
    case 'BILLING':
      if (
        current.lastBillingSeq !== null &&
        cause.sequence <= current.lastBillingSeq
      )
        return { kind: 'STALE', lastBillingSeq: current.lastBillingSeq };
      return settle(current, target, 'BILLING', cause.ref, null);
    case 'PLATFORM_ADMIN':
      if (cause.expectedVersion !== current.version)
        return { kind: 'VERSION_MISMATCH' };
      return settle(current, target, 'PLATFORM_ADMIN', null, cause.reason);
    default: {
      const unknownCause: never = cause;
      throw new Error(
        `unknown assignment cause ${String(Reflect.get(unknownCause, 'kind'))}`,
      );
    }
  }
}
