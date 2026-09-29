import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CatalogueCheck } from './application/catalogue-check.js';
import { OrgPurgeParticipantRegistry } from './application/org-purge-participant.registry.js';
import {
  PermissionCatalogueContributor,
  PermissionCatalogueRegistry,
} from './application/permission-catalogue.registry.js';
import { TenancyMetrics } from './application/tenancy-metrics.js';
import { TENANCY_CATALOGUE } from './domain/tenancy-catalogue.js';
import { SqlCatalogueReader } from './infra/sql/sql-catalogue.reader.js';
import { CatalogueReader } from './ports/catalogue-reader.js';
import {
  NoopTenancyTestHooks,
  TenancyTestHooks,
} from './ports/tenancy-test-hooks.js';
import './events.js';
import './errors.js';
import './tenancy.config.js';

@Injectable()
@PermissionCatalogueContributor(TENANCY_CATALOGUE)
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
  ],
  exports: [
    TenancyMetrics,
    PermissionCatalogueRegistry,
    OrgPurgeParticipantRegistry,
    TenancyTestHooks,
  ],
})
export class TenancyCoreModule {}

/** Task 20 thêm repository, Task 22 thêm HTTP (api), Task 25 thêm purge + gate job (worker). */
@Module({})
export class TenancyModule {
  static forApi(): DynamicModule {
    return { module: TenancyModule, imports: [TenancyCoreModule] };
  }
  static forWorker(): DynamicModule {
    return { module: TenancyModule, imports: [TenancyCoreModule] };
  }
}
