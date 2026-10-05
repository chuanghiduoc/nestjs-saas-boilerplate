import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { IdentityErrors } from '../errors.js';
import { identityConfig, type IdentityConfig } from '../identity.config.js';
import { StaffStepUp } from '../infra/better-auth/staff-step-up.js';
import type { AuthResult } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';
import { decideStaffAccess, isAuthTimeFresh } from './staff-access.js';

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
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
    /** Chỉ `local`/`hybrid` (`BetterAuthCoreModule`); `external` không có Better Auth → luôn `undefined`. */
    @Optional() private readonly stepUp?: StaffStepUp,
  ) {}

  /**
   * Review M-3 (3D): quyền nền tảng NGOÀI `/admin/*` (vd. `TENANCY_ORG_CREATION=platform_admin`) đòi CÙNG quyết định với
   * `PlatformStaffGuard` (addendum A1.2): session Better Auth → dấu TOTP tươi trên factor hiện tại; `external` →
   * `auth_time` tươi; key → từ chối. Ném `AppError` của quyết định; lỗi hạ tầng của câu dấu ném nguyên (map 503). Gọi
   * NGOÀI transaction của pool app (câu trên pool `auth_user`).
   */
  async requireFreshStaffAccess(): Promise<void> {
    const auth = this.state.get();
    const mode = this.identity.mode;
    let d = decideStaffAccess({
      auth,
      mode,
      authTimeFresh: isAuthTimeFresh(auth, this.identity),
    });
    if (d === 'CHECK_TOTP_MARK') {
      if (
        auth.kind !== 'AUTHENTICATED' ||
        auth.sessionId === undefined ||
        !this.stepUp
      )
        throw new Error(
          'requireFreshStaffAccess needs StaffStepUp and a session id for a Better Auth staff session',
        );
      d = decideStaffAccess({
        auth,
        mode,
        totpMarkFresh: await this.stepUp.totpMarkFresh(
          auth.principal.id,
          auth.sessionId,
          this.identity.sessionFreshAgeSec,
        ),
      });
    }
    switch (d) {
      case 'ALLOW':
        return;
      case 'UNAUTHENTICATED':
        throw new AppError(CoreErrors.UNAUTHENTICATED);
      case 'FORBIDDEN':
        throw new AppError(CoreErrors.FORBIDDEN);
      case 'SECOND_FACTOR_REQUIRED':
        throw new AppError(IdentityErrors.SECOND_FACTOR_REQUIRED);
      case 'REAUTHENTICATION_REQUIRED':
        throw new AppError(IdentityErrors.REAUTHENTICATION_REQUIRED);
      case 'CHECK_TOTP_MARK':
        throw new Error('decideStaffAccess asked for the TOTP mark twice');
      default: {
        const unknown: never = d;
        throw new Error(`unknown staff decision ${String(unknown)}`);
      }
    }
  }
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
