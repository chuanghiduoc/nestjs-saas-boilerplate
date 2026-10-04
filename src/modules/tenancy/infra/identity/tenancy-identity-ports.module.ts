import { Global, Module } from '@nestjs/common';
import {
  OrgCredentialAuthenticator,
  UserDeletionGuard,
} from '../../../identity/index.js';
import { UserDeletionService } from '../../application/user-deletion.service.js';
import { OrgApiKeyAuthenticator } from './org-api-key.authenticator.js';

/**
 * `@Global`: `BetterAuthCoreModule` (identity) inject `{ token: UserDeletionGuard, optional: true }` (spec SP3 §5.2);
 * identity không import tenancy (luật 18). Vắng module này (app không bật tenancy) → hook dựa vào FK `RESTRICT` + `onError`.
 * 3D: `OrgCredentialAuthenticator` (§5.2; `PrincipalResolver` inject `@Optional()`, vắng thì mọi `oak_…` là 401).
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
  ],
  exports: [UserDeletionGuard, OrgCredentialAuthenticator],
})
export class TenancyIdentityPortsModule {}
