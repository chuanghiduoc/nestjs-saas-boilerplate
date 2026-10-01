import { Module, type INestApplication } from '@nestjs/common';
import { ProvisionOrgSubscriber } from '../../src/modules/entitlements/application/provision-org.subscriber.js';
import type { PlanCatalogue } from '../../src/modules/entitlements/domain/plan-catalogue.js';
import { EntitlementsModule } from '../../src/modules/entitlements/index.js';
import type { ModuleImport } from './app-factory.js';
import { startTenancyApp, type TenancyAppOpts } from './tenancy-app.js';
import { tenancyCoreImports } from './tenancy-core-app.js';

/**
 * Hạ tầng core + tenancy (worker) + `EntitlementsModule.forWorker(plans)`: service, participant, subscriber, purge (không
 * HTTP). `entitlementPermissions: false`: `EntitlementsCoreModule` đã góp `EntitlementPermissions`, góp thêm lần nữa thì
 * `PermissionCatalogueRegistry` từ chối boot (ca đầu của `catalogue-check.spec.ts`, Task 8, là test hồi quy của điều này).
 */
export const entitlementsCoreImports = (
  plans: PlanCatalogue,
  extra: ModuleImport[] = [],
): ModuleImport[] => [
  ...tenancyCoreImports({ entitlementPermissions: false }),
  EntitlementsModule.forWorker(plans),
  ...extra,
];

/** App e2e là api + worker events trong một process: subscriber dự phòng (chỉ ở `forWorker`) cần có mặt để event được giao. */
@Module({ providers: [ProvisionOrgSubscriber] })
export class EntitlementsProvisionTestModule {}

/**
 * App e2e của tenancy (api + worker events/notifications trong một process) + `EntitlementsModule.forApi(plans)`.
 * `entitlementPermissions: false` luôn thắng `opts`: catalogue quyền của entitlements đã do `EntitlementsCoreModule` góp.
 */
export function startEntitlementsApp(
  plans: PlanCatalogue,
  opts: Omit<TenancyAppOpts, 'entitlementPermissions'> = {},
): Promise<INestApplication> {
  return startTenancyApp({
    ...opts,
    entitlementPermissions: false,
    extraImports: [
      EntitlementsModule.forApi(plans),
      EntitlementsProvisionTestModule,
      ...(opts.extraImports ?? []),
    ],
  });
}
