import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ActorReauthorizer } from './application/actor-reauthorizer.js';
import { CatalogueCheck } from './application/catalogue-check.js';
import { EscalationGuard } from './application/escalation-guard.js';
import { MemberAdmission } from './application/member-admission.js';
import { OrgLifecycleService } from './application/org-lifecycle.service.js';
import { TenancyOrgMutationLock } from './application/org-mutation-lock.service.js';
import { OrgPurgeParticipantRegistry } from './application/org-purge-participant.registry.js';
import {
  PurgeOrgHandler,
  PurgeOrgsHandler,
} from './application/purge-orgs.handler.js';
import { ScheduledTasksPurgeParticipant } from './application/scheduled-tasks.participant.js';
import { SubjectResolver } from './application/subject-resolver.js';
import {
  PermissionCatalogueContributor,
  PermissionCatalogueRegistry,
} from './application/permission-catalogue.registry.js';
import { TenancyMetrics } from './application/tenancy-metrics.js';
import { TenancyHttpModule } from './http/tenancy-http.module.js';
import { TenancyPermissions } from './permissions.js';
import { TenancyIdentityPortsModule } from './infra/identity/tenancy-identity-ports.module.js';
import { TenancyQueuePortsModule } from './infra/queue/tenancy-queue-ports.module.js';
import { SqlCatalogueReader } from './infra/sql/sql-catalogue.reader.js';
import { SqlMemberRepository } from './infra/sql/sql-member.repository.js';
import { SqlOrgRepository } from './infra/sql/sql-org.repository.js';
import { SqlRoleRepository } from './infra/sql/sql-role.repository.js';
import { SqlTenancyUserRepository } from './infra/sql/sql-tenancy-user.repository.js';
import { CatalogueReader } from './ports/catalogue-reader.js';
import { MemberRepository } from './ports/member-repository.js';
import { OrgMutationLock } from './ports/org-mutation-lock.js';
import { OrgRepository } from './ports/org-repository.js';
import { RoleRepository } from './ports/role-repository.js';
import { TenancyUserRepository } from './ports/tenancy-user-repository.js';
import {
  NoopTenancyTestHooks,
  TenancyTestHooks,
} from './ports/tenancy-test-hooks.js';
import './events.js';
import './jobs.js';
import './errors.js';
import './tenancy.config.js';

@Injectable()
@PermissionCatalogueContributor(TenancyPermissions)
class TenancyCatalogueContributor {}

/**
 * Phần dùng chung api + worker. `@Global` vì `PoliciesGuard` (Task 21) gắn vào controller của `features/` và cần
 * registry + metric ở mọi module; `TenancyTestHooks` cũng vậy (test thay một chỗ).
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    TenancyMetrics,
    PermissionCatalogueRegistry,
    OrgPurgeParticipantRegistry,
    TenancyCatalogueContributor,
    SqlCatalogueReader,
    { provide: CatalogueReader, useExisting: SqlCatalogueReader },
    CatalogueCheck,
    { provide: TenancyTestHooks, useClass: NoopTenancyTestHooks },
    SubjectResolver,
    SqlTenancyUserRepository,
    { provide: TenancyUserRepository, useExisting: SqlTenancyUserRepository },
    SqlOrgRepository,
    { provide: OrgRepository, useExisting: SqlOrgRepository },
    SqlRoleRepository,
    { provide: RoleRepository, useExisting: SqlRoleRepository },
    SqlMemberRepository,
    { provide: MemberRepository, useExisting: SqlMemberRepository },
    ActorReauthorizer,
    MemberAdmission,
    OrgLifecycleService,
    EscalationGuard,
    ScheduledTasksPurgeParticipant,
    TenancyOrgMutationLock,
    { provide: OrgMutationLock, useExisting: TenancyOrgMutationLock },
  ],
  exports: [
    TenancyMetrics,
    PermissionCatalogueRegistry,
    OrgPurgeParticipantRegistry,
    TenancyTestHooks,
    SubjectResolver,
    TenancyUserRepository,
    OrgRepository,
    RoleRepository,
    MemberRepository,
    ActorReauthorizer,
    MemberAdmission,
    OrgLifecycleService,
    EscalationGuard,
    OrgMutationLock,
  ],
})
export class TenancyCoreModule {}

/** Task 20 thêm repository, Task 22 thêm HTTP (api), Task 25 thêm purge + gate job (worker). */
@Module({})
export class TenancyModule {
  static forApi(): DynamicModule {
    return {
      module: TenancyModule,
      imports: [
        TenancyCoreModule,
        TenancyHttpModule,
        TenancyIdentityPortsModule,
      ],
    };
  }
  static forWorker(): DynamicModule {
    return {
      module: TenancyModule,
      imports: [TenancyCoreModule, TenancyQueuePortsModule],
      providers: [PurgeOrgsHandler, PurgeOrgHandler],
    };
  }
}
