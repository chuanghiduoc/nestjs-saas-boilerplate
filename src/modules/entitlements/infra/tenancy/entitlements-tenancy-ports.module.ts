import { Global, Module } from '@nestjs/common';
import { MemberSeatLimit } from '../../../tenancy/index.js';
import { MemberSeatLimitAdapter } from './member-seat-limit.adapter.js';

/**
 * `@Global`: `MemberAdmission` (tenancy, `TenancyCoreModule` `@Global`) inject `@Optional()` token `MemberSeatLimit`;
 * tenancy không import entitlements (luật 20.8-a). Cùng mẫu `TenancyIdentityPortsModule`. Nạp ở CẢ api lẫn worker (spec
 * §9.6: admission chạy ở api; worker giữ đối xứng để composition thật của cả hai vai cùng hình dạng).
 */
@Global()
@Module({
  providers: [
    MemberSeatLimitAdapter,
    { provide: MemberSeatLimit, useExisting: MemberSeatLimitAdapter },
  ],
  exports: [MemberSeatLimit],
})
export class EntitlementsTenancyPortsModule {}
