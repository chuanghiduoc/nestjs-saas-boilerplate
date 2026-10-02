import { Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { StaffStepUp } from '../infra/better-auth/staff-step-up.js';
import type { AuthResult } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';

type Authenticated = Extract<AuthResult, { kind: 'AUTHENTICATED' }>;
const SECOND_FACTOR_KEY = 'identity:secondFactorVerifiedAt';

/**
 * Sự thật về principal của request, chỉ đọc (spec SP3 §5.2): tenancy dùng thay vì đọc `AuthState` (luật
 * `modules-only-index-of-other-modules`). Đồng bộ, từ kết quả xác thực đã có; không query — trừ
 * `secondFactorVerifiedAt()` (đọc lười, 3D). Không có principal → mọi giá trị "không" (false/undefined).
 */
@Injectable()
export class AuthFacts {
  constructor(
    private readonly state: AuthState,
    private readonly cls: ClsService,
    /** Chỉ `local`/`hybrid` (`BetterAuthCoreModule`); `external` không có Better Auth → luôn `undefined`. */
    @Optional() private readonly stepUp?: StaffStepUp,
  ) {}
  private authed(): Authenticated | undefined {
    const r = this.state.get();
    return r.kind === 'AUTHENTICATED' ? r : undefined;
  }
  isPlatformAdmin(): boolean {
    return this.authed()?.isPlatformAdmin ?? false;
  }
  authenticatedAt(): Date | undefined {
    return this.authed()?.authenticatedAt;
  }
  emailVerified(): boolean {
    return this.authed()?.emailVerified ?? false;
  }
  verifiedEmail(): string | undefined {
    return this.authed()?.verifiedEmail;
  }

  /**
   * Spec SP3 §5.2 hàng `AuthFacts` (3D): lần step-up gần nhất của CHÍNH session này trên factor hiện tại (TOTP hoặc backup
   * code). Đọc LƯỜI — chỉ nhánh support grant của `OrgContextMiddleware` gọi, sau khi đã tìm thấy grant (DB2-N8) — một câu
   * trên pool `auth_user`, cache trong CLS của request. Credential không phải session → `undefined`; 0 dòng (chưa step-up,
   * factor bị gỡ/thay, session vừa bị thu hồi: dấu `CASCADE`) → `undefined` (fail closed); lỗi hạ tầng → ném.
   */
  async secondFactorVerifiedAt(): Promise<Date | undefined> {
    const a = this.authed();
    if (!a || a.sessionId === undefined || !this.stepUp) return undefined;
    const cached = this.cls.get<{ value: Date | undefined } | undefined>(
      SECOND_FACTOR_KEY,
    );
    if (cached) return cached.value;
    const value = await this.stepUp.anyMarkVerifiedAt(
      a.sessionId,
      a.principal.id,
    );
    this.cls.set(SECOND_FACTOR_KEY, { value });
    return value;
  }
}
