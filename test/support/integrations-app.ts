import type { INestApplication } from '@nestjs/common';
import { FlagsModule } from '../../src/core/flags/index.js';
import { SweepModule } from '../../src/core/sweep/index.js';
import {
  HOST_RESOLVER,
  type HostResolver,
} from '../../src/modules/integrations/infra/dns-url-guard.js';
import { IntegrationsModule } from '../../src/modules/integrations/index.js';
import type { ConfigureTestingModule, ModuleImport } from './app-factory.js';
import { startTenancyApp } from './tenancy-app.js';
import { tenancyCoreImports } from './tenancy-core-app.js';

/** IP công khai thật (không bao giờ được kết nối trong test: resolver giả chỉ dùng ở `UrlGuard`). */
export const PUBLIC_IP = '93.184.215.14';
/** Resolver giả của `UrlGuard`: mọi tên ra `PUBLIC_IP`, trừ tên trong `overrides`. */
export const fixedResolver =
  (overrides: Record<string, readonly string[]> = {}): HostResolver =>
  async (host) =>
    (overrides[host] ?? [PUBLIC_IP]).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
export const endpointsUrl = (orgId: string): string =>
  `/v1/orgs/${orgId}/webhook-endpoints`;

export type IntegrationsAppOpts = {
  env?: Record<string, string>;
  resolver?: HostResolver;
  configure?: ConfigureTestingModule;
  extraImports?: ModuleImport[];
  /** Mặc định `false`: test gọi handler gửi trực tiếp (tất định). `true`: worker của app consume `webhooks-out` (luồng thật). */
  consumeWebhooks?: boolean;
};

/**
 * App e2e của tenancy (api + worker events/notifications) + `FlagsModule`, `SweepModule` + `IntegrationsModule.forApi()` và
 * `.forWorker()` trong một process (mẫu `startEntitlementsApp`). `HOST_RESOLVER` luôn bị thay bằng resolver giả: test không
 * bao giờ phân giải DNS thật.
 */
export function startIntegrationsApp(
  opts: IntegrationsAppOpts = {},
): Promise<INestApplication> {
  const resolver = opts.resolver ?? fixedResolver();
  return startTenancyApp({
    // IntegrationsCoreModule góp catalogue `integrations`; module test thay thế của tenancy-app không được góp lần hai.
    integrationPermissions: false,
    env: {
      ...(opts.consumeWebhooks
        ? { WORKER_QUEUES: 'events,notifications,webhooks-out' }
        : {}),
      ...opts.env,
    },
    configure: (b) => {
      const withResolver = b.overrideProvider(HOST_RESOLVER).useValue(resolver);
      return opts.configure ? opts.configure(withResolver) : withResolver;
    },
    extraImports: [
      FlagsModule,
      SweepModule,
      IntegrationsModule.forApi(),
      IntegrationsModule.forWorker(),
      ...(opts.extraImports ?? []),
    ],
  });
}

/** Hạ tầng core + tenancy (worker) + integrations worker, không HTTP: handler, participant, sweep. */
export const integrationsCoreImports = (
  extra: ModuleImport[] = [],
): ModuleImport[] => [
  ...tenancyCoreImports({ integrationPermissions: false }),
  FlagsModule,
  SweepModule,
  IntegrationsModule.forWorker(),
  ...extra,
];
