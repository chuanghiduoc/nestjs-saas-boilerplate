import {
  Global,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { IdentityMetricsModule } from '../../identity-metrics.js';
import { identityConfig, type IdentityConfig } from '../../identity.config.js';
import { AuthMountMiddleware } from './auth-mount.middleware.js';
import { IdentityBodyParserOwner } from './body-parser-owner.js';
import { BetterAuthCoreModule } from './better-auth-core.module.js';
import { SignOutHandler } from './sign-out.js';

/**
 * `local`/`hybrid` ở api: tự mount Better Auth sau port `AuthProvider` (quyết định ở Task 1: không dùng thallesp).
 * Core bỏ qua `AUTH_BASE_PATH` khi đọc body qua marker `@BodyParserOwner` (`IdentityBodyParserOwner`): `AuthMountMiddleware`
 * kiểm đa credential + CSRF rồi mới đọc (spec §5.5).
 */
@Global()
@Module({
  imports: [BetterAuthCoreModule, IdentityMetricsModule],
  providers: [SignOutHandler, AuthMountMiddleware, IdentityBodyParserOwner],
})
export class BetterAuthApiModule implements NestModule {
  constructor(
    @Inject(identityConfig.KEY) private readonly identity: IdentityConfig,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMountMiddleware).forRoutes({
      path: `${this.identity.basePath}/{*path}`,
      method: RequestMethod.ALL,
    });
  }
}
