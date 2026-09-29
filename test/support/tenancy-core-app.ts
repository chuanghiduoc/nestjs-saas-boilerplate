import { DatabaseModule } from '../../src/core/database/index.js';
import { EventsModule } from '../../src/core/events/index.js';
import { OutboxModule } from '../../src/core/outbox/index.js';
import { QueueModule } from '../../src/core/queue/index.js';
import { RedisModule } from '../../src/core/redis/index.js';
import { SchedulerModule } from '../../src/core/scheduler/index.js';
import { TenancyModule } from '../../src/modules/tenancy/index.js';
import type { ModuleImport } from './app-factory.js';
import { EntitlementPermissionsCatalogueModule } from './entitlement-permissions.module.js';

/**
 * Hạ tầng core + `TenancyModule.forWorker()` (không HTTP, không identity HTTP): đủ cho `CatalogueCheck`, repository, gate
 * job và service vòng đời. Route/pipeline test qua `startTenancyApp` (Task 22).
 * `entitlementPermissions: false` khi app cũng nạp `EntitlementsModule` (nó đã góp catalogue quyền của entitlements).
 */
export const tenancyCoreImports = ({
  entitlementPermissions = true,
}: { entitlementPermissions?: boolean } = {}): ModuleImport[] => [
  DatabaseModule.forRoot({ relay: false }),
  RedisModule,
  QueueModule.forRoot({ runWorkers: false }),
  OutboxModule.forRoot({ relay: false }),
  EventsModule.forRoot({ worker: false }),
  SchedulerModule.forRoot({ worker: false }),
  TenancyModule.forWorker(),
  ...(entitlementPermissions ? [EntitlementPermissionsCatalogueModule] : []),
];
