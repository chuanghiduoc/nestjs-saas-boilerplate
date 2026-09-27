import type { DynamicModule, Type } from '@nestjs/common';
import { IdentityModule } from './modules/identity/index.js';
import { NotificationsModule } from './modules/notifications/index.js';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền và feature mà dự án bật. Boilerplate bật sẵn identity + notifications (spec SP2 §6). */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [NotificationsModule.forApi(), IdentityModule.forApi()],
  worker: [NotificationsModule.forWorker(), IdentityModule.forWorker()],
};
