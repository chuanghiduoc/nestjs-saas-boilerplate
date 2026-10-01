import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  defineErrorCodes,
  registerErrorMapper,
  type ErrorMapper,
} from '../../core/errors/index.js';

/** Mã do entitlements sở hữu (spec §15, cột "Chủ" = entitlements). Mã core dùng lại, không định nghĩa lại. */
export const EntitlementsErrors = defineErrorCodes({
  PLAN_RETIRED: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'The plan is retired and cannot be newly assigned',
  },
  UNKNOWN_PLAN: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unknown plan',
  },
});

/** Tên trigger (migration `entitlements_core`) → mã; tên không bao giờ ra client. Trigger seq chỉ bắn khi code sai (log ERROR ở service). */
defineConstraintErrors({
  org_entitlements_plan_not_retired: EntitlementsErrors.PLAN_RETIRED,
  org_entitlements_billing_seq_monotonic: CoreErrors.VALIDATION_FAILED,
});

/** Thiếu UnitOfWork đang mở hoặc org context: lỗi lắp ráp (500). */
export class EntitlementsContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementsContextError';
  }
}
/** `planKey` không có trong catalogue gói của pod hoặc trong bảng `plans` (500; route admin 4C đổi thành 422 `unknown_plan`). */
export class UnknownPlanError extends Error {
  constructor(readonly planKey: string) {
    super(
      `Plan "${planKey}" is not in this pod's plan catalogue or in the plans table`,
    );
    this.name = 'UnknownPlanError';
  }
}
/** Org không có dòng `org_entitlements` (503 + Retry-After; subscriber dự phòng tự lành, F-2). */
export class EntitlementsRowMissingError extends Error {
  constructor(readonly retryAfterSec: number) {
    super('The organization has no org_entitlements row');
    this.name = 'EntitlementsRowMissingError';
  }
}
/** Gói hiện tại của org lạ với catalogue của pod khi đọc snapshot (rolling deploy, F-6): 503. */
export class EntitlementsVersionSkewError extends Error {
  constructor(readonly planKey: string) {
    super(
      `The organization is on plan "${planKey}", which this pod does not know`,
    );
    this.name = 'EntitlementsVersionSkewError';
  }
}
export class UnknownFeatureError extends Error {
  constructor(readonly featureKey: string) {
    super(`Feature "${featureKey}" is not in any registered feature catalogue`);
    this.name = 'UnknownFeatureError';
  }
}
export class FeatureKindMismatchError extends Error {
  constructor(
    readonly featureKey: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Feature "${featureKey}" is a ${actual}, the call needs ${expected}`);
    this.name = 'FeatureKindMismatchError';
  }
}
/** Trả quota nhiều hơn đã dùng (4B `Quotas.release*`): lỗi lập trình, không kẹp về 0 âm thầm. */
export class QuotaReleaseUnderflowError extends Error {
  constructor(
    readonly featureKey: string,
    readonly amount: number,
  ) {
    super(
      `Releasing ${amount} of "${featureKey}" would make its usage negative`,
    );
    this.name = 'QuotaReleaseUnderflowError';
  }
}

/** Hai lỗi "chưa sẵn sàng" → 503 (F-2, F-6); mọi lớp khác rơi về 500 của `toAppError` (lỗi lập trình). */
export const entitlementsErrorMapper: ErrorMapper = (err) => {
  if (err instanceof EntitlementsRowMissingError)
    return new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
      headers: { 'Retry-After': String(err.retryAfterSec) },
      expected: true,
    });
  if (err instanceof EntitlementsVersionSkewError)
    return new AppError(CoreErrors.SERVICE_UNAVAILABLE, { expected: true });
  return undefined;
};
registerErrorMapper(entitlementsErrorMapper);

const featureField = (featureKey: string, message: string) => [
  { path: 'feature', code: featureKey, message },
];
/** S4-D14: key tính năng ở `errors[0]` để client biết tính năng nào mà không parse `detail`. */
export const featureNotInPlan = (featureKey: string): AppError =>
  new AppError(CoreErrors.FEATURE_NOT_IN_PLAN, {
    fields: featureField(featureKey, CoreErrors.FEATURE_NOT_IN_PLAN.title),
    expected: true,
  });
export const quotaExceeded = (featureKey: string): AppError =>
  new AppError(CoreErrors.QUOTA_EXCEEDED, {
    fields: featureField(featureKey, CoreErrors.QUOTA_EXCEEDED.title),
    expected: true,
  });
