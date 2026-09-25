import type { DynamicModule, Type } from '@nestjs/common';

type ModuleImport = Type<unknown> | DynamicModule;

/** Module nền và feature mà dự án bật. Boilerplate để trống. */
export const APP_MODULES: { api: ModuleImport[]; worker: ModuleImport[] } = {
  api: [],
  worker: [],
};
