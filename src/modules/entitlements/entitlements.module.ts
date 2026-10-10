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
import { EntitlementsPurgeParticipant } from './application/org-purge.participant.js';
import { PlanAssignments } from './application/plan-assignments.service.js';
import { ProvisionOrgParticipant } from './application/provision-org.participant.js';
import { ProvisionOrgSubscriber } from './application/provision-org.subscriber.js';
import { SqlEntitlementCatalogueReader } from './infra/sql/sql-entitlement-catalogue.reader.js';
import { Quotas } from './application/quotas.service.js';
import { EntitlementsTenancyPortsModule } from './infra/tenancy/entitlements-tenancy-ports.module.js';
import { SqlUsageCounterRepository } from './infra/sql/sql-usage-counter.repository.js';
import { EntitlementCatalogueReader } from './ports/catalogue.reader.js';
import { UsageCounterRepository } from './ports/usage-counter.repository.js';
import { SqlOverrideRepository } from './infra/sql/sql-override.repository.js';
import { OverrideRepository } from './ports/override.repository.js';
import type { PlanCatalogue } from './domain/plan-catalogue.js';
import { BoilerplateFeatures } from './features.js';
import { EntitlementsHttpModule } from './http/entitlements-http.module.js';
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
        SqlUsageCounterRepository,
        {
          provide: UsageCounterRepository,
          useExisting: SqlUsageCounterRepository,
        },
        SqlOverrideRepository,
        {
          provide: OverrideRepository,
          useExisting: SqlOverrideRepository,
        },
        // Tạo org chạy ở api; worker đối xứng (spec §13.2).
        ProvisionOrgParticipant,
        PlanAssignments,
        Quotas,
      ],
      exports: [
        ENTITLEMENT_PLANS,
        EntitlementsMetrics,
        EntitlementCatalogueRegistry,
        OrgEntitlementRepository,
        Entitlements,
        PlanAssignments,
        UsageCounterRepository,
        OverrideRepository,
        Quotas,
      ],
    };
  }
}

/**
 * api: HTTP (route tenant + route inventory). worker: subscriber dự phòng `tenancy.org.created` (api không có
 * `SubscriberRegistry`) và participant purge (purge chạy ở worker). Cả hai vai: port ghế của tenancy
 * (`EntitlementsTenancyPortsModule`, spec §9.6).
 */
@Module({})
export class EntitlementsModule {
  static forApi(plans: PlanCatalogue): DynamicModule {
    return {
      module: EntitlementsModule,
      imports: [
        EntitlementsCoreModule.register(plans),
        EntitlementsHttpModule,
        EntitlementsTenancyPortsModule,
      ],
    };
  }
  static forWorker(plans: PlanCatalogue): DynamicModule {
    return {
      module: EntitlementsModule,
      imports: [
        EntitlementsCoreModule.register(plans),
        EntitlementsTenancyPortsModule,
      ],
      providers: [ProvisionOrgSubscriber, EntitlementsPurgeParticipant],
    };
  }
}
