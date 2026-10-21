import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { FeatureCatalogueContributor } from '../../modules/entitlements/index.js';
import { PermissionCatalogueContributor } from '../../modules/tenancy/index.js';
import { ExampleMetrics } from './application/example-metrics.js';
import { ProjectService } from './application/project.service.js';
import { ExampleFeatures } from './entitlements.js';
import { ProjectRepository } from './infra/sql-project.repository.js';
import { ExamplePermissions } from './permissions.js';
import './errors.js';
import './events.js';
import './example.config.js';
import './jobs.js';

@Injectable()
@PermissionCatalogueContributor(ExamplePermissions)
class ExamplePermissionsContributor {}

@Injectable()
@FeatureCatalogueContributor(ExampleFeatures)
class ExampleFeaturesContributor {}

/**
 * Phần dùng chung api + worker (mẫu `IntegrationsCoreModule`): `forApi()` và `forWorker()` cùng import module tĩnh này, nên
 * một process dựng cả hai (test e2e) chỉ có một instance. Catalogue quyền và tính năng ở CẢ HAI vai trò (SP3 INT3-5): boot
 * nào cũng so code với DB.
 */
@Module({
  providers: [
    ExamplePermissionsContributor,
    ExampleFeaturesContributor,
    ProjectRepository,
    ExampleMetrics,
  ],
  exports: [ProjectRepository, ExampleMetrics],
})
export class ExampleCoreModule {}

/** Chỉ api: service của route (controller ở Task 7). */
@Module({
  imports: [ExampleCoreModule],
  providers: [ProjectService],
})
export class ExampleHttpModule {}

/** Chỉ worker: job xoá theo org, handler quét, participant xoá cứng org (Task 9). */
@Module({ imports: [ExampleCoreModule] })
export class ExampleWorkerModule {}

@Module({})
export class ExampleModule {
  static forApi(): DynamicModule {
    return {
      module: ExampleModule,
      imports: [ExampleCoreModule, ExampleHttpModule],
    };
  }
  static forWorker(): DynamicModule {
    return {
      module: ExampleModule,
      imports: [ExampleCoreModule, ExampleWorkerModule],
    };
  }
}
