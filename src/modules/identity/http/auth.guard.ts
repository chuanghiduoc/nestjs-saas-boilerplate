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
  identityGuardConfig,
  type IdentityGuardConfig,
} from '../identity.config.js';
import { AuthState } from './auth-state.js';
import { SESSION_ONLY } from './session-only.decorator.js';

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
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true;
    const r = this.state.get();
    switch (r.kind) {
      case 'AUTHENTICATED':
        if (isPublic) return true;
        if (
          r.credential.kind === 'API_KEY' &&
          this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, targets)
        )
          throw new AppError(CoreErrors.FORBIDDEN, {
            detail: 'This operation requires a signed-in session',
          });
        return true;
      case 'ANONYMOUS':
        if (isPublic) return true;
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
