import { Global, Module } from '@nestjs/common';
import { IdentityMetricsModule } from '../identity-metrics.js';
import { AuthFacts } from './auth-facts.js';
import { AuthState } from './auth-state.js';
import { PrincipalResolver } from './principal-resolver.js';

/**
 * `@Global()` (spec SP3 §5.2): tenancy inject `PrincipalResolver` (và `AuthFacts`, Task 10) mà không import module của
 * identity. Không đăng ký middleware ở đây: `IdentityHttpModule` (không global) vẫn đăng ký `PrincipalMiddleware`, nên
 * thứ tự middleware giữa module giữ nguyên cơ chế `distance` của Nest.
 */
@Global()
@Module({
  imports: [IdentityMetricsModule],
  providers: [AuthState, PrincipalResolver, AuthFacts],
  exports: [AuthState, PrincipalResolver, AuthFacts],
})
export class IdentityRequestModule {}
