import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { PUBLIC_ROUTE } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import {
  identityConfig,
  identityGuardConfig,
  type IdentityConfig,
  type IdentityGuardConfig,
} from '../identity.config.js';
import type { AuthResult } from '../ports/auth-provider.js';
import { AuthState } from './auth-state.js';
import {
  REQUIRE_FRESH_SESSION,
  REQUIRE_VERIFIED_EMAIL,
} from './fresh-session.decorator.js';
import { SESSION_ONLY } from './session-only.decorator.js';

const MS_PER_SECOND = 1000;

/**
 * APP_GUARD mặc định chặn. `@PublicRoute()` chỉ miễn cho request KHÔNG mang credential (review I7): credential
 * có mặt mà sai (`REJECTED`) là 401, session của user chưa xác thực email (`EMAIL_NOT_VERIFIED`, S2-R76) là 403 và
 * storage auth lỗi (`UNAVAILABLE`) là 503 ở mọi route, để client không lặng lẽ bị coi là ẩn danh (vd. `x-api-key`
 * rỗng do lỗi cấu hình).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly state: AuthState,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: IdentityGuardConfig,
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
  ) {}

  /**
   * Spec SP3 §5.2. API key không bao giờ "mới" (không có lần đăng nhập), BẤT KỂ `authenticatedAt` mà một port (vd.
   * `oak_`) gắn vào. `authenticatedAt` ở tương lai chỉ được nhận trong dung sai lệch đồng hồ
   * `AUTH_EXTERNAL_CLOCK_TOLERANCE_SEC` (cùng dung sai dùng cho `iat`/`nbf`); xa hơn là dữ liệu sai, không phải "mới".
   */
  private isFresh(r: Extract<AuthResult, { kind: 'AUTHENTICATED' }>): boolean {
    if (r.credential.kind === 'API_KEY' || r.authenticatedAt === undefined)
      return false;
    const ageMs = Date.now() - r.authenticatedAt.getTime();
    return (
      ageMs <= this.identity.sessionFreshAgeSec * MS_PER_SECOND &&
      ageMs >= -this.identity.externalClockToleranceSec * MS_PER_SECOND
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const flag = (key: string) =>
      this.reflector.getAllAndOverride<boolean>(key, targets) === true;
    const isPublic = flag(PUBLIC_ROUTE);
    // Fail closed: `@RequireFreshSession()`/`@RequireVerifiedEmail()` cần một principal chứng minh được, nên
    // `@PublicRoute()` không miễn hai yêu cầu này (không có principal → 401, có mà thiếu bằng chứng → 403).
    const requireVerified = flag(REQUIRE_VERIFIED_EMAIL);
    const requireFresh = flag(REQUIRE_FRESH_SESSION);
    const r = this.state.get();
    switch (r.kind) {
      case 'AUTHENTICATED':
        if (!isPublic && r.credential.kind === 'API_KEY' && flag(SESSION_ONLY))
          throw new AppError(CoreErrors.FORBIDDEN, {
            detail: 'This operation requires a signed-in session',
          });
        if (requireVerified && !r.emailVerified)
          throw new AppError(IdentityErrors.EMAIL_NOT_VERIFIED);
        if (requireFresh && !this.isFresh(r))
          throw new AppError(IdentityErrors.REAUTHENTICATION_REQUIRED);
        return true;
      case 'ANONYMOUS':
        if (isPublic && !requireVerified && !requireFresh) return true;
        throw new AppError(CoreErrors.UNAUTHENTICATED);
      case 'REJECTED':
        throw new AppError(CoreErrors.UNAUTHENTICATED);
      // Như REJECTED: credential có mặt mà không dùng được thì lỗi ở mọi route, kể cả `@PublicRoute()` (review I7).
      case 'EMAIL_NOT_VERIFIED':
        throw new AppError(IdentityErrors.EMAIL_NOT_VERIFIED);
      case 'UNAVAILABLE':
        throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
          headers: {
            'Retry-After': String(this.guard.unavailableRetryAfterSec),
          },
          expected: true,
        });
      default: {
        const unknown: never = r;
        throw new Error(`unknown auth result ${JSON.stringify(unknown)}`);
      }
    }
  }
}
