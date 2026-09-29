/**
 * Seam cho test race có lịch cố định (spec SP3 §18.3: X-4 `afterGuard`, O-18 `beforeRelease`). Production dùng
 * `NoopTenancyTestHooks`; test thay bằng `overrideProvider`. Luật depcruise 19: không import ngoài `modules/tenancy`.
 */
export abstract class TenancyTestHooks {
  /** Sau `PoliciesGuard`, trước transaction của mutation quản trị. */
  abstract afterGuard(): Promise<void>;
  /** Trước khi `release` xử lý org `orgId` của user bị xoá. */
  abstract beforeRelease(authUserId: string, orgId: string): Promise<void>;
}
export class NoopTenancyTestHooks extends TenancyTestHooks {
  afterGuard(): Promise<void> {
    return Promise.resolve();
  }
  beforeRelease(): Promise<void> {
    return Promise.resolve();
  }
}
