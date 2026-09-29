import { Global, Module } from '@nestjs/common';
import { UserDeletionGuard } from '../../../identity/index.js';
import { UserDeletionService } from '../../application/user-deletion.service.js';

/**
 * `@Global`: `BetterAuthCoreModule` (identity) inject `{ token: UserDeletionGuard, optional: true }` (spec SP3 §5.2);
 * identity không import tenancy (luật 18). Vắng module này (app không bật tenancy) → hook dựa vào FK `RESTRICT` + `onError`.
 */
@Global()
@Module({
  providers: [
    UserDeletionService,
    { provide: UserDeletionGuard, useExisting: UserDeletionService },
  ],
  exports: [UserDeletionGuard],
})
export class TenancyIdentityPortsModule {}
