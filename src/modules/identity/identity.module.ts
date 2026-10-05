import {
  type DynamicModule,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PurgeExpiredHandler } from './application/purge-expired.handler.js';
import { ReconcileRegisteredHandler } from './application/reconcile-registered.handler.js';
import { ReconcileSecurityNoticesHandler } from './application/reconcile-security-notices.handler.js';
import { AuthGuard } from './http/auth.guard.js';
import { IdentityRequestModule } from './http/identity-request.module.js';
import { MeController } from './http/me.controller.js';
import { PlatformStaffGuardModule } from './http/platform-staff-guard.module.js';
import { PrincipalMiddleware } from './http/principal.middleware.js';
import { IdentityMetricsModule } from './identity-metrics.js';
import {
  identityConfig,
  isBetterAuthMode,
  isExternalMode,
  type IdentityConfig,
} from './identity.config.js';
import { BetterAuthApiModule } from './infra/better-auth/better-auth-api.module.js';
import { BetterAuthCoreModule } from './infra/better-auth/better-auth-core.module.js';
import { DashboardAuthorizerModule } from './infra/dashboard/dashboard-authorizer.module.js';
import { ExternalAuthModule } from './infra/jwks/external-auth.module.js';
import './events.js';
import './jobs.js';

/** Route wildcard toàn cục theo cú pháp path-to-regexp 8 (giống HttpModule). */
const ALL_ROUTES = '{*path}';

@Module({ controllers: [MeController] })
class LocalHttpModule {}

/**
 * Chỉ ở api: middleware xác định principal cho mọi route Nest + guard mặc định chặn. Ở `local`/`hybrid` loại trừ
 * prefix auth (review I9): ở đó `AuthMountMiddleware` tự kiểm đa credential/CSRF và không bao giờ gọi `next()`. Ở
 * `external` không có mount nên KHÔNG loại trừ (review M4): route Nest dưới `AUTH_BASE_PATH` vẫn qua kiểm
 * credential/CSRF, không rơi về ANONYMOUS. `IdentityMetricsModule` import trực tiếp vì ở `external` không có
 * `BetterAuthApiModule`.
 */
@Module({
  imports: [IdentityMetricsModule, IdentityRequestModule],
  providers: [PrincipalMiddleware, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class IdentityHttpModule implements NestModule {
  constructor(
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
  ) {}
  configure(consumer: MiddlewareConsumer): void {
    const principal = consumer.apply(PrincipalMiddleware);
    if (this.identity.mode === 'external') {
      principal.forRoutes(ALL_ROUTES);
      return;
    }
    principal
      .exclude({
        path: `${this.identity.basePath}/${ALL_ROUTES}`,
        method: RequestMethod.ALL,
      })
      .forRoutes(ALL_ROUTES);
  }
}

/**
 * `debug: false`: nhánh bị bỏ qua được `ConditionalModule` báo bằng `Logger` tĩnh lúc quét module, TRƯỚC khi logger
 * JSON (pino) được gắn, nên thành một dòng log thô không phải JSON ở production (smoke bắt được). Mode đang chạy đã
 * rõ từ `AUTH_MODE`.
 */
const QUIET = { debug: false };

@Module({})
export class IdentityModule {
  /** api: mount theo `AUTH_MODE` bằng `ConditionalModule` (đọc env sau khi ConfigModule nạp, spec §5.5). */
  static forApi(): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        ConditionalModule.registerWhen(
          BetterAuthApiModule,
          isBetterAuthMode,
          QUIET,
        ),
        ConditionalModule.registerWhen(
          LocalHttpModule,
          isBetterAuthMode,
          QUIET,
        ),
        ConditionalModule.registerWhen(
          ExternalAuthModule,
          isExternalMode,
          QUIET,
        ),
        IdentityHttpModule,
        // Addendum A1.4 (3D): guard của `@PlatformStaffAction()` cho module khác, không cần import identity.
        PlatformStaffGuardModule,
      ],
    };
  }

  /**
   * worker: pool + instance + cron, không mount HTTP. Handler cron luôn có (maintenance queue), tự bỏ qua ở
   * `external`. `DashboardAuthorizerModule` nạp không điều kiện theo mode (Task 45): Bull Board bật cờ riêng
   * (`QUEUE_DASHBOARD_ENABLED`) độc lập với `AUTH_MODE` (spec §5.12: ở `external` cookie/bearer token của IdP
   * dùng được như nhau), và cổng `AuthProvider` nó cần do `BetterAuthCoreModule` (local/hybrid) hoặc
   * `ExternalAuthModule` (external) cung cấp.
   */
  static forWorker(): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        ConditionalModule.registerWhen(
          BetterAuthCoreModule,
          isBetterAuthMode,
          QUIET,
        ),
        ConditionalModule.registerWhen(
          ExternalAuthModule,
          isExternalMode,
          QUIET,
        ),
        DashboardAuthorizerModule,
      ],
      providers: [
        ReconcileRegisteredHandler,
        ReconcileSecurityNoticesHandler,
        PurgeExpiredHandler,
      ],
    };
  }
}
