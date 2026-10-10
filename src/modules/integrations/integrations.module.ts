import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { ResilienceModule } from '../../core/resilience/index.js';
import { SecurityModule } from '../../core/security/index.js';
import { PermissionCatalogueContributor } from '../tenancy/index.js';
import { WebhookEventCatalogueCheck } from './application/event-catalogue-check.js';
import { IntegrationsMetrics } from './application/integrations-metrics.js';
import { EndpointService } from './application/endpoint.service.js';
import { WebhookSecrets } from './application/webhook-secrets.js';
import { EventTypesController } from './http/event-types.controller.js';
import { WebhookEndpointsController } from './http/webhook-endpoints.controller.js';
import {
  DnsUrlGuard,
  HOST_RESOLVER,
  dnsResolver,
} from './infra/dns-url-guard.js';
import { SqlEndpointRepository } from './infra/sql/sql-endpoint.repository.js';
import { StandardWebhooksSigner } from './infra/standard-webhooks.signer.js';
import { EndpointRepository } from './ports/endpoint-repository.js';
import { UrlGuard } from './ports/url-guard.js';
import { WebhookSigner } from './ports/webhook-signer.js';
import { WebhookPermissions } from './permissions.js';
import './errors.js';
import './events.js';
import './integrations.config.js';
import './jobs.js';
import './kill-switches.js';
import './partitions.js';

@Injectable()
@PermissionCatalogueContributor(WebhookPermissions)
class IntegrationsCatalogueContributor {}

/**
 * Phần dùng chung api + worker (mẫu `TenancyCoreModule`): `forApi()` và `forWorker()` cùng import module tĩnh này, nên một
 * process dựng cả hai (test e2e) vẫn chỉ có một instance. Catalogue quyền ở cả hai process (SP3 INT3-5).
 * `SecurityModule`/`ResilienceModule` phải được module dùng đăng ký (ADR 0016 "Hệ quả").
 */
@Global()
@Module({
  imports: [SecurityModule, ResilienceModule],
  providers: [
    IntegrationsMetrics,
    IntegrationsCatalogueContributor,
    WebhookEventCatalogueCheck,
    { provide: HOST_RESOLVER, useValue: dnsResolver },
    DnsUrlGuard,
    { provide: UrlGuard, useExisting: DnsUrlGuard },
    StandardWebhooksSigner,
    { provide: WebhookSigner, useExisting: StandardWebhooksSigner },
    WebhookSecrets,
    SqlEndpointRepository,
    { provide: EndpointRepository, useExisting: SqlEndpointRepository },
  ],
  exports: [
    IntegrationsMetrics,
    WebhookEventCatalogueCheck,
    UrlGuard,
    WebhookSigner,
    WebhookSecrets,
    EndpointRepository,
  ],
})
export class IntegrationsCoreModule {}

/** Chỉ api: controller (Task 8, 9, 14). */
@Module({
  controllers: [WebhookEndpointsController, EventTypesController],
  providers: [EndpointService],
})
export class IntegrationsHttpModule {}

/** Chỉ api: bản cài token `WebhookStatsReader` của `core/contracts` cho admin (Task 10, R-X16). */
@Global()
@Module({ providers: [], exports: [] })
export class IntegrationsReadersModule {}

/** Chỉ worker: fan-out, gửi, sweep, participant, policy của `webhooks-out` (Task 10–15). */
@Module({ providers: [] })
export class IntegrationsWorkerModule {}

@Module({})
export class IntegrationsModule {
  static forApi(): DynamicModule {
    return {
      module: IntegrationsModule,
      imports: [
        IntegrationsCoreModule,
        IntegrationsHttpModule,
        IntegrationsReadersModule,
      ],
    };
  }
  static forWorker(): DynamicModule {
    return {
      module: IntegrationsModule,
      imports: [IntegrationsCoreModule, IntegrationsWorkerModule],
    };
  }
}
