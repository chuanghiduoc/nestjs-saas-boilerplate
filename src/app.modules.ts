import type { DynamicModule, Type } from '@nestjs/common';
// N7: rule chéo module (retention notifications vs TTL token identity) đăng ký ở đây — chỗ THẬT SỰ compose cả hai.
import './composition.config.js';
import { EntitlementsModule } from './modules/entitlements/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { TenancyModule } from './modules/tenancy/index.js';
import { examplePlans } from './plans.example.js';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền mà dự án bật: identity + notifications + tenancy + entitlements (spec SP2 §6, SP3 §5.1, SP4 §6.2). */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [
    NotificationsModule.forApi(),
    IdentityModule.forApi(),
    TenancyModule.forApi(),
    EntitlementsModule.forApi(examplePlans),
  ],
  worker: [
    NotificationsModule.forWorker(),
    IdentityModule.forWorker(),
    TenancyModule.forWorker(),
    EntitlementsModule.forWorker(examplePlans),
  ],
};
