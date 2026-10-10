import { Injectable, Module } from '@nestjs/common';
import { WebhookPermissions } from '../../src/modules/integrations/permissions.js';
import { PermissionCatalogueContributor } from '../../src/modules/tenancy/index.js';

@Injectable()
@PermissionCatalogueContributor(WebhookPermissions)
class WebhookPermissionsOnly {}

/**
 * Mẫu `EntitlementPermissionsCatalogueModule`: DB đã migrate mang `webhooks.read`/`webhooks.write` (migration 6C), còn app
 * test của tenancy dựng không có IntegrationsModule. Module này giữ app test cùng hình dạng production khi integrations bật
 * (key không mồ côi, không WARN `catalogue_orphan_keys`). App nào nạp IntegrationsModule thì KHÔNG được nạp module này
 * (catalogue `integrations` bị góp hai lần → `PermissionCatalogueRegistry` ném): truyền `integrationPermissions: false`.
 */
@Module({ providers: [WebhookPermissionsOnly] })
export class IntegrationPermissionsCatalogueModule {}
