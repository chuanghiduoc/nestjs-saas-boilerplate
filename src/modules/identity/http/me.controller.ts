import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, serialize } from '../../../core/http/index.js';
import { IdentityErrors } from '../errors.js';
import { IdentityMetrics } from '../identity-metrics.js';
import { safeErrorFields } from '../identity-telemetry.js';
import {
  identityGuardConfig,
  type IdentityGuardConfig,
} from '../identity.config.js';
import { isAuthInfraError } from '../infra/better-auth/auth-error.mapper.js';
import { AuthDatabaseReadiness } from '../infra/better-auth/auth-readiness.js';
import {
  IdentityDirectory,
  type DirectoryUser,
  hasAdminRole,
} from '../ports/identity-directory.js';
import { MeResponse } from './schemas.js';

/** Chỉ đăng ký ở `local`/`hybrid` (`LocalHttpModule`): dữ liệu user nằm trong DB auth của Better Auth. */
@Controller('v1/me')
export class MeController {
  private readonly logger = new Logger(MeController.name);

  constructor(
    private readonly ctx: RequestContext,
    private readonly directory: IdentityDirectory,
    private readonly storage: AuthDatabaseReadiness,
    private readonly metrics: IdentityMetrics,
    @Inject(identityGuardConfig.KEY)
    private readonly guard: IdentityGuardConfig,
  ) {}

  /** Gọi bằng API key thì trả user sở hữu key (spec §5.6.4). */
  @Get()
  @ApiOk(MeResponse)
  @ApiProblems(
    IdentityErrors.AMBIGUOUS_CREDENTIALS,
    CoreErrors.UNAUTHENTICATED,
    CoreErrors.RATE_LIMITED,
    CoreErrors.SERVICE_UNAVAILABLE,
  )
  async me(): Promise<MeResponse> {
    const p = this.ctx.principal();
    const user = p ? await this.findUser(p.id) : undefined;
    if (!user) throw new AppError(CoreErrors.UNAUTHENTICATED);
    return serialize(MeResponse, {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      role: hasAdminRole(user.role) ? 'ADMIN' : 'USER',
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    });
  }

  /**
   * Pool `auth_user` lỗi giữa middleware và handler (vd. hết chờ connection) là `503` + `Retry-After` (spec §5.5
   * quy tắc 4), không phải `500`: cùng cách nhận diện với mount (Task 36) — lỗi hạ tầng đã biết, không thì hỏi lại
   * pool bằng probe có hạn; DB khoẻ thì lỗi là bug và được ném nguyên.
   */
  private async findUser(id: string): Promise<DirectoryUser | undefined> {
    try {
      return await this.directory.findUser(id);
    } catch (err) {
      if (!isAuthInfraError(err) && !(await this.storageDown())) throw err;
      this.logger.warn(
        { event: 'auth_unavailable', ...safeErrorFields(err) },
        'authentication storage unavailable while loading the current user',
      );
      this.metrics.unavailable.add(1);
      throw new AppError(CoreErrors.SERVICE_UNAVAILABLE, {
        headers: {
          'Retry-After': String(this.guard.unavailableRetryAfterSec),
        },
        expected: true,
      });
    }
  }

  private async storageDown(): Promise<boolean> {
    try {
      await this.storage.probe();
      return false;
    } catch {
      return true;
    }
  }
}
