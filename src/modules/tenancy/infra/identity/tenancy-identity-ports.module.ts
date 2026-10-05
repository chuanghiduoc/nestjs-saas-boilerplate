import { Global, Module } from '@nestjs/common';
import {
  OrgCredentialAuthenticator,
  PlatformRoleChangeListener,
  UserDeletionGuard,
} from '../../../identity/index.js';
import { UserDeletionService } from '../../application/user-deletion.service.js';
import { OrgApiKeyAuthenticator } from './org-api-key.authenticator.js';
import { TenancyPlatformRoleChangeListener } from './platform-role-change.listener.js';

/**
 * `@Global`: `BetterAuthCoreModule` (identity) inject `{ token: UserDeletionGuard, optional: true }` (spec SP3 §5.2);
 * identity không import tenancy (luật 18). Vắng module này (app không bật tenancy) → hook dựa vào FK `RESTRICT` + `onError`.
 * 3D: `OrgCredentialAuthenticator` (§5.2; `PrincipalResolver` inject `@Optional()`, vắng thì mọi `oak_…` là 401) và
 * `PlatformRoleChangeListener` (§9.7 (6): ghi role nền tảng thu hồi support grant; cùng cách inject tuỳ chọn).
 */
@Global()
@Module({
  providers: [
    UserDeletionService,
    { provide: UserDeletionGuard, useExisting: UserDeletionService },
    OrgApiKeyAuthenticator,
    {
      provide: OrgCredentialAuthenticator,
      useExisting: OrgApiKeyAuthenticator,
    },
    TenancyPlatformRoleChangeListener,
    {
      provide: PlatformRoleChangeListener,
      useExisting: TenancyPlatformRoleChangeListener,
    },
  ],
  exports: [
    UserDeletionGuard,
    OrgCredentialAuthenticator,
    PlatformRoleChangeListener,
  ],
})
export class TenancyIdentityPortsModule {}
