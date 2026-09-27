import { Global, Module } from '@nestjs/common';
import { ResilienceModule } from '../../../../core/resilience/index.js';
import { AuthProvider } from '../../ports/auth-provider.js';
import { JwksAuthProvider } from './jwks.provider.js';

/**
 * `external` (api và worker): không có Better Auth, pool `auth_user` hay `/api/auth/*`; parser body vẫn do core
 * (spec §5.5). `@Global()` để `PrincipalMiddleware` (api) và `PlatformAdminAuthorizer` (worker) inject được cổng.
 */
@Global()
@Module({
  imports: [ResilienceModule],
  providers: [
    JwksAuthProvider,
    { provide: AuthProvider, useExisting: JwksAuthProvider },
  ],
  exports: [AuthProvider],
})
export class ExternalAuthModule {}
