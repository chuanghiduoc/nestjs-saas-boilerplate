import type { DynamicModule, Type } from '@nestjs/common';
// N7: rule chéo module (retention notifications vs TTL token identity) đăng ký ở đây — chỗ THẬT SỰ compose cả hai.
import './composition.config.js';
import { IdentityModule } from './modules/identity/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { TenancyModule } from './modules/tenancy/index.js';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền và feature mà dự án bật. Boilerplate bật sẵn identity + notifications + tenancy (spec SP2 §6, SP3 §5.1). */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [
    NotificationsModule.forApi(),
    IdentityModule.forApi(),
    TenancyModule.forApi(),
  ],
  worker: [
    NotificationsModule.forWorker(),
    IdentityModule.forWorker(),
    TenancyModule.forWorker(),
  ],
};
