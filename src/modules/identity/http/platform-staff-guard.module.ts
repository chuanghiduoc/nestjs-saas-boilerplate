import { Global, Module } from '@nestjs/common';
import { IdentityMetricsModule } from '../identity-metrics.js';
import { PlatformStaffGuard } from './platform-staff.guard.js';

/**
 * Addendum A1.4: `@Global` (chỉ `IdentityModule.forApi()`), để module của SP4/SP5/SP6 dùng `@PlatformStaffAction()` mà
 * không import module nội bộ của identity. `AuthState` do `IdentityRequestModule` (`@Global`) cung cấp; `StaffStepUp` do
 * `BetterAuthCoreModule` (`@Global`, local/hybrid). Worker không có route HTTP nên không có module này.
 */
@Global()
@Module({
  imports: [IdentityMetricsModule],
  providers: [PlatformStaffGuard],
  exports: [PlatformStaffGuard],
})
export class PlatformStaffGuardModule {}
