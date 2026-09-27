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
import { AuthGuard } from './http/auth.guard.js';
import { AuthState } from './http/auth-state.js';
import { MeController } from './http/me.controller.js';
import { PrincipalMiddleware } from './http/principal.middleware.js';
import { IdentityMetricsModule } from './identity-metrics.js';
import {
  identityConfig,
  isBetterAuthMode,
  type IdentityConfig,
} from './identity.config.js';
import { BetterAuthApiModule } from './infra/better-auth/better-auth-api.module.js';
import { BetterAuthCoreModule } from './infra/better-auth/better-auth-core.module.js';
import './events.js';
import './jobs.js';

/** Route wildcard toàn cục theo cú pháp path-to-regexp 8 (giống HttpModule). */
const ALL_ROUTES = '{*path}';

@Module({ controllers: [MeController] })
class LocalHttpModule {}

/**
 * Chỉ ở api: middleware xác định principal cho mọi route Nest + guard mặc định chặn. Loại trừ prefix auth
 * (review I9): ở đó `AuthMountMiddleware` tự kiểm đa credential/CSRF và không bao giờ gọi `next()`.
 * `IdentityMetricsModule` import trực tiếp vì ở `AUTH_MODE=external` không có `BetterAuthApiModule`.
 */
@Module({
  imports: [IdentityMetricsModule],
  providers: [
    AuthState,
    PrincipalMiddleware,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class IdentityHttpModule implements NestModule {
  constructor(
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
  ) {}
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PrincipalMiddleware)
      .exclude({
        path: `${this.identity.basePath}/${ALL_ROUTES}`,
        method: RequestMethod.ALL,
      })
      .forRoutes(ALL_ROUTES);
  }
}

@Module({})
export class IdentityModule {
  /** api: mount theo `AUTH_MODE` bằng `ConditionalModule` (đọc env sau khi ConfigModule nạp, spec §5.5). */
  static forApi(): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        ConditionalModule.registerWhen(BetterAuthApiModule, isBetterAuthMode),
        ConditionalModule.registerWhen(LocalHttpModule, isBetterAuthMode),
        IdentityHttpModule,
      ],
    };
  }

  /** worker: pool + instance + cron, không mount HTTP. Handler cron luôn có (maintenance queue), tự bỏ qua ở `external`. */
  static forWorker(): DynamicModule {
    return {
      module: IdentityModule,
      imports: [
        ConditionalModule.registerWhen(BetterAuthCoreModule, isBetterAuthMode),
      ],
      providers: [ReconcileRegisteredHandler, PurgeExpiredHandler],
    };
  }
}
