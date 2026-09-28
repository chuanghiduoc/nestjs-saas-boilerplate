import { Global, Module } from '@nestjs/common';
import { QueueDashboardAuthorizer } from '../../../../core/queue/index.js';
import { IdentityMetricsModule } from '../../identity-metrics.js';
import { PlatformAdminAuthorizer } from './platform-admin.authorizer.js';

/**
 * Cung cấp `QueueDashboardAuthorizer` cho worker (spec §5.12); `@Global()` để `QueueDashboardServer` inject được
 * mà không phải import lại module này ở nơi khai báo nó.
 *
 * Nhập `IdentityMetricsModule` ngay ở đây (Task 45 fix round 1, review M3), không phải ở `forWorker()`: module
 * kia đang được Task 41 sửa song song. `IdentityMetricsModule` cũng `@Global()`, nên `IdentityMetrics` vẫn có
 * mặt cho mọi provider khác của worker, giống cách `IdentityHttpModule` đã làm cho api.
 */
@Global()
@Module({
  imports: [IdentityMetricsModule],
  providers: [
    PlatformAdminAuthorizer,
    { provide: QueueDashboardAuthorizer, useExisting: PlatformAdminAuthorizer },
  ],
  exports: [QueueDashboardAuthorizer],
})
export class DashboardAuthorizerModule {}
