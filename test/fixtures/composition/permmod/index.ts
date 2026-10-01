import { Injectable, Module } from '@nestjs/common';
import { markModuleLoaded } from '../../../../src/core/config/index.js';
import { defineCatalogue } from '../../../../src/modules/tenancy/domain/catalogue.js';
import { PermissionCatalogueContributor } from '../../../../src/modules/tenancy/index.js';

/**
 * Module nền giả góp một catalogue quyền (R-X21). Migration của module đã seed dòng `permmod.read` vào `permissions`;
 * khi dự án tắt module, dòng đó ở lại trong DB mà không catalogue TS nào khai (orphan).
 */
markModuleLoaded('permmod');

export const PermmodCatalogue = defineCatalogue('permmod', {
  'permmod.read': {
    resource: 'permmod',
    action: 'read',
    requires: [],
    ownerOnly: false,
    apiKeyEligible: false,
    supportEligible: false,
    grantTo: { admin: false, member: false },
  },
});

@Injectable()
@PermissionCatalogueContributor(PermmodCatalogue)
class PermmodCatalogueContributor {}

@Module({ providers: [PermmodCatalogueContributor] })
export class PermmodModule {}
