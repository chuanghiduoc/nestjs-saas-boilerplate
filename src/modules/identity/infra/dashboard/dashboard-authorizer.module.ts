import { Global, Module } from '@nestjs/common';
import { QueueDashboardAuthorizer } from '../../../../core/queue/index.js';
import { PlatformAdminAuthorizer } from './platform-admin.authorizer.js';

/** Cung cấp `QueueDashboardAuthorizer` cho worker (spec §5.12); `@Global()` để `QueueDashboardServer` inject được
 * mà không phải import lại module này ở nơi khai báo nó. */
@Global()
@Module({
  providers: [
    PlatformAdminAuthorizer,
    { provide: QueueDashboardAuthorizer, useExisting: PlatformAdminAuthorizer },
  ],
  exports: [QueueDashboardAuthorizer],
})
export class DashboardAuthorizerModule {}
