import { Injectable, Module } from '@nestjs/common';
import { EntitlementPermissions } from '../../src/modules/entitlements/permissions.js';
import { PermissionCatalogueContributor } from '../../src/modules/tenancy/index.js';

@Injectable()
@PermissionCatalogueContributor(EntitlementPermissions)
class EntitlementPermissionsOnly {}

/**
 * App test của tenancy dựng không có EntitlementsModule, nhưng DB đã migrate mang `entitlements.read` (migration 4A).
 * Từ 3A Task 20b (R-X21), key chỉ có ở DB chỉ là WARN + `tenancy_catalogue_orphan_keys`, không chặn boot; module này giữ
 * app test của tenancy cùng hình dạng production (entitlements luôn được nạp nên key không bao giờ mồ côi) và không có WARN
 * đó. App nào nạp EntitlementsModule thì KHÔNG được nạp module này: `EntitlementsCoreModule` đã góp cùng đối tượng
 * catalogue, và `PermissionCatalogueRegistry` của 3A ném `Permission catalogue "entitlements" is contributed twice` khi
 * một catalogue được góp hai lần. Vì vậy `tenancyCoreImports`/`startTenancyApp` có tuỳ chọn `entitlementPermissions: false`.
 */
@Module({ providers: [EntitlementPermissionsOnly] })
export class EntitlementPermissionsCatalogueModule {}
