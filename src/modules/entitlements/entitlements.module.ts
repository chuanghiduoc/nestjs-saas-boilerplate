import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PermissionCatalogueContributor } from '../tenancy/index.js';
import {
  ENTITLEMENT_PLANS,
  EntitlementCatalogueRegistry,
  FeatureCatalogueContributor,
} from './application/entitlement-catalogue.registry.js';
import { Entitlements } from './application/entitlements.service.js';
import { EntitlementsMetrics } from './application/entitlements-metrics.js';
import { EntitlementCatalogueCheck } from './application/catalogue-check.js';
import { SqlEntitlementCatalogueReader } from './infra/sql/sql-entitlement-catalogue.reader.js';
import { EntitlementCatalogueReader } from './ports/catalogue.reader.js';
import type { PlanCatalogue } from './domain/plan-catalogue.js';
import { BoilerplateFeatures } from './features.js';
import { SqlOrgEntitlementRepository } from './infra/sql/sql-org-entitlement.repository.js';
import { EntitlementPermissions } from './permissions.js';
import { OrgEntitlementRepository } from './ports/org-entitlement.repository.js';
import './entitlements.config.js';
import './errors.js';
import './events.js';

@Injectable()
@FeatureCatalogueContributor(BoilerplateFeatures)
class BoilerplateFeaturesContributor {}

@Injectable()
@PermissionCatalogueContributor(EntitlementPermissions)
class EntitlementPermissionsContributor {}

/**
 * Phần dùng chung api + worker. `@Global` vì `EntitlementInterceptor` được Nest khởi tạo trong module của controller dùng
 * `requireEnabled` (controller của `features/`) và feature inject `Entitlements` (cùng lý do `TenancyCoreModule`).
 * Catalogue quyền và catalogue tính năng nằm ở CẢ HAI vai trò (SP3 §8.2 INT3-5).
 */
@Global()
@Module({})
export class EntitlementsCoreModule {
  static register(plans: PlanCatalogue): DynamicModule {
    return {
      module: EntitlementsCoreModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: ENTITLEMENT_PLANS, useValue: plans },
        EntitlementsMetrics,
        EntitlementCatalogueRegistry,
        BoilerplateFeaturesContributor,
        EntitlementPermissionsContributor,
        SqlOrgEntitlementRepository,
        {
          provide: OrgEntitlementRepository,
          useExisting: SqlOrgEntitlementRepository,
        },
        Entitlements,
        SqlEntitlementCatalogueReader,
        {
          provide: EntitlementCatalogueReader,
          useExisting: SqlEntitlementCatalogueReader,
        },
        EntitlementCatalogueCheck,
      ],
      exports: [
        ENTITLEMENT_PLANS,
        EntitlementsMetrics,
        EntitlementCatalogueRegistry,
        OrgEntitlementRepository,
        Entitlements,
      ],
    };
  }
}

/** Task 8 thêm catalogue check, Task 9/10 thêm HTTP (api), Task 11 thêm participant/subscriber/purge, Task 12 PlanAssignments. */
@Module({})
export class EntitlementsModule {
  static forApi(plans: PlanCatalogue): DynamicModule {
    return {
      module: EntitlementsModule,
      imports: [EntitlementsCoreModule.register(plans)],
    };
  }
  static forWorker(plans: PlanCatalogue): DynamicModule {
    return {
      module: EntitlementsModule,
      imports: [EntitlementsCoreModule.register(plans)],
    };
  }
}
