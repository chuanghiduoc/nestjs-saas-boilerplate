import { defineRequestState } from '@better-auth/core/context';
import type { LockoutTicket } from './login-lockout.js';
import type { StepUpMark } from './staff-step-up.js';

/**
 * Trạng thái theo request giữa hook `before` và `after` (vé lockout đã consume, user của một thao tác có thể đổi 2FA).
 *
 * Dùng request state CÓ SẴN của Better Auth (`defineRequestState`, `@better-auth/core/context`) thay vì một
 * AsyncLocalStorage tự viết (luật "có sẵn trước"): mọi lời gọi endpoint, cả `auth.handler` lẫn `auth.api.*`,
 * đều chạy trong `runWithRequestState` (`better-auth/dist/api/to-auth-endpoints.mjs`), và `before`/`after` của
 * cùng một lời gọi dùng chung một store. Vì vậy không có đường nào mất vé lockout (đăng nhập đúng bị tính là sai)
 * hay mất user của thao tác 2FA (đường gửi nhanh của thông báo bảo mật không chạy; cron vẫn gửi bù), và mount
 * (Task 36) không phải mở scope. Không phụ thuộc CLS của Nest (S1b).
 *
 * Gọi ngoài một lời gọi của Better Auth thì `get`/`set` ném (`No request state found`): lỗi lập trình, ném to.
 */
export class AuthRequestState {
  private readonly tickets = defineRequestState<LockoutTicket[]>(() => []);
  private readonly twoFactorSubject = defineRequestState<string | null>(
    () => null,
  );

  async addTicket(t: LockoutTicket): Promise<void> {
    (await this.tickets.get()).push(t);
  }
  async takeTickets(): Promise<LockoutTicket[]> {
    return (await this.tickets.get()).splice(0);
  }
  async setTwoFactorUser(userId: string): Promise<void> {
    await this.twoFactorSubject.set(userId);
  }
  async twoFactorUser(): Promise<string | null> {
    return this.twoFactorSubject.get();
  }
  /** Spec SP3 §9.7 (1)→(2): `{ sessionId, factorId, method }` chụp ở `before` (TRƯỚC khi handler đọc factor, T-37). */
  private readonly stepUpMark = defineRequestState<StepUpMark | null>(
    () => null,
  );
  async setStepUp(m: StepUpMark | null): Promise<void> {
    await this.stepUpMark.set(m);
  }
  async stepUp(): Promise<StepUpMark | null> {
    return this.stepUpMark.get();
  }
}
