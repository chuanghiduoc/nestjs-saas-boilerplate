import { defineRequestState } from '@better-auth/core/context';
import type { LockoutTicket } from './login-lockout.js';

/** Trạng thái 2FA của user TRƯỚC thao tác (`/two-factor/verify-totp`, `/two-factor/disable`). */
export type TwoFactorBefore = {
  userId: string;
  sessionId: string;
  enabled: boolean;
};

/**
 * Trạng thái theo request giữa hook `before` và `after` (vé lockout đã consume, trạng thái 2FA trước thao tác).
 *
 * Dùng request state CÓ SẴN của Better Auth (`defineRequestState`, `@better-auth/core/context`) thay vì một
 * AsyncLocalStorage tự viết (luật "có sẵn trước"): mọi lời gọi endpoint, cả `auth.handler` lẫn `auth.api.*`,
 * đều chạy trong `runWithRequestState` (`better-auth/dist/api/to-auth-endpoints.mjs`), và `before`/`after` của
 * cùng một lời gọi dùng chung một store. Vì vậy không có đường nào mất vé lockout (đăng nhập đúng bị tính là sai)
 * hay mất trạng thái 2FA (thông báo bảo mật không gửi), và mount (Task 36) không phải mở scope. Không phụ thuộc
 * CLS của Nest (S1b).
 *
 * Gọi ngoài một lời gọi của Better Auth thì `get`/`set` ném (`No request state found`): lỗi lập trình, ném to.
 */
export class AuthRequestState {
  private readonly tickets = defineRequestState<LockoutTicket[]>(() => []);
  private readonly twoFactor = defineRequestState<TwoFactorBefore | null>(
    () => null,
  );

  async addTicket(t: LockoutTicket): Promise<void> {
    (await this.tickets.get()).push(t);
  }
  async takeTickets(): Promise<LockoutTicket[]> {
    return (await this.tickets.get()).splice(0);
  }
  async setTwoFactorBefore(v: TwoFactorBefore): Promise<void> {
    await this.twoFactor.set(v);
  }
  async twoFactorBefore(): Promise<TwoFactorBefore | null> {
    return this.twoFactor.get();
  }
}
