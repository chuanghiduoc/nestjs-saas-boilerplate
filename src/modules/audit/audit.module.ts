import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { PermissionCatalogueContributor } from '../tenancy/index.js';
import { AuditMetrics } from './application/audit-metrics.js';
import { AuditPermissions } from './permissions.js';
import './audit.config.js';
import './events.js';
import './partitions.js';

@Injectable()
@PermissionCatalogueContributor(AuditPermissions)
class AuditCatalogueContributor {}

/**
 * Phần dùng chung api + worker (mẫu `IntegrationsCoreModule`): `forApi()` và `forWorker()` cùng import module tĩnh này,
 * nên một process dựng cả hai (test e2e) vẫn chỉ có một instance. Catalogue quyền ở cả hai process (SP3 INT3-5).
 */
@Global()
@Module({
  providers: [AuditMetrics, AuditCatalogueContributor],
  exports: [AuditMetrics],
})
export class AuditCoreModule {}

/** Chỉ api: API đọc theo org. */
@Module({})
export class AuditHttpModule {}

/** Chỉ api: bản cài `PlatformAccessAudit` của identity (`@Global` + `@Optional` của addendum A3). */
@Global()
@Module({})
export class AuditIdentityPortsModule {}

/** Chỉ worker: subscriber `audit.recorder`. */
@Module({})
export class AuditWorkerModule {}

@Module({})
export class AuditModule {
  static forApi(): DynamicModule {
    return {
      module: AuditModule,
      imports: [AuditCoreModule, AuditHttpModule, AuditIdentityPortsModule],
    };
  }
  static forWorker(): DynamicModule {
    return {
      module: AuditModule,
      imports: [AuditCoreModule, AuditWorkerModule],
    };
  }
}
