import { DatabaseModule } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { SchedulerModule } from '../../src/core/scheduler/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { TenancyModule } from '../../src/modules/tenancy/index.js';
import type { ModuleImport } from './app-factory.js';
import { AuditPermissionsCatalogueModule } from './audit-permissions.module.js';
import { EntitlementPermissionsCatalogueModule } from './entitlement-permissions.module.js';
import { IntegrationPermissionsCatalogueModule } from './integration-permissions.module.js';

/**
 * Hạ tầng core + `TenancyModule.forWorker()` (không HTTP, không identity HTTP): đủ cho `CatalogueCheck`, repository, gate
 * job và service vòng đời. Route/pipeline test qua `startTenancyApp` (Task 22).
 * `NotificationsModule.forApi()` (chỉ ghi DB + enqueue): subscriber `tenancy.notify-owners.*` của `forWorker` (3D) cần
 * `EmailNotifications`, như production (tenancy cần identity, identity cần notifications: `MODULE_REQUIRES`).
 * `entitlementPermissions: false` khi app cũng nạp `EntitlementsModule` (nó đã góp catalogue quyền của entitlements);
 * `integrationPermissions: false` khi app cũng nạp `IntegrationsModule` (cùng lý do, catalogue `integrations`);
 * `auditPermissions: false` khi app cũng nạp `AuditModule` (catalogue `audit`).
 */
export const tenancyCoreImports = ({
  entitlementPermissions = true,
  integrationPermissions = true,
  auditPermissions = true,
}: {
  entitlementPermissions?: boolean;
  integrationPermissions?: boolean;
  auditPermissions?: boolean;
} = {}): ModuleImport[] => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  SchedulerModule.forRoot({ worker: false }),
  NotificationsModule.forApi(),
  TenancyModule.forWorker(),
  ...(entitlementPermissions ? [EntitlementPermissionsCatalogueModule] : []),
  ...(integrationPermissions ? [IntegrationPermissionsCatalogueModule] : []),
  ...(auditPermissions ? [AuditPermissionsCatalogueModule] : []),
];
