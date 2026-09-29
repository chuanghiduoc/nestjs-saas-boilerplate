import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SchedulerModule } from '../../src/core/scheduler/index.js';
import { TenancyModule } from '../../src/modules/tenancy/index.js';
import {
  nestedIn,
  type ConfigureTestingModule,
  type ModuleImport,
} from './app-factory.js';
import { EntitlementPermissionsCatalogueModule } from './entitlement-permissions.module.js';
import { startIdentityApp } from './identity-app.js';
import type { SeededPrincipal } from './tenancy-principals.js';

export type TenancyAppOpts = {
  env?: Record<string, string>;
  extraImports?: ModuleImport[];
  configure?: ConfigureTestingModule;
  identityDepth?: number;
  tenancyDepth?: number;
  /** Mặc định `true`; `false` khi `extraImports` có `EntitlementsModule` (catalogue quyền của nó không được góp hai lần). */
  entitlementPermissions?: boolean;
};

/**
 * App e2e của identity (api + worker events/notifications, relay chạy) cộng `SchedulerModule` (không worker: service vòng
 * đời org treo/khôi phục lịch, như `AppApiModule`) và `TenancyModule.forApi()`.
 */
export function startTenancyApp(
  opts: TenancyAppOpts = {},
): Promise<INestApplication> {
  return startIdentityApp({
    env: opts.env,
    configure: opts.configure,
    identityDepth: opts.identityDepth,
    extraImports: [
      SchedulerModule.forRoot({ worker: false }),
      nestedIn(TenancyModule.forApi(), opts.tenancyDepth ?? 0),
      ...(opts.entitlementPermissions === false
        ? []
        : [EntitlementPermissionsCatalogueModule]),
      ...(opts.extraImports ?? []),
    ],
  });
}

/** Request với bearer của principal seed (plugin `bearer`). */
export const authed = (app: INestApplication, p: SeededPrincipal) => {
  const agent = request(app.getHttpServer());
  const auth = `Bearer ${p.bearer}`;
  return {
    get: (url: string) => agent.get(url).set('authorization', auth),
    post: (url: string) => agent.post(url).set('authorization', auth),
    patch: (url: string) => agent.patch(url).set('authorization', auth),
    delete: (url: string) => agent.delete(url).set('authorization', auth),
  };
};
