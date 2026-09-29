import { Controller, Get } from '@nestjs/common';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
import { PermissionListResponse } from './schemas.js';

/** Catalogue gộp, bỏ deprecated, cho UI dựng màn role (spec SP3 §7.2). Cần principal (AuthGuard), không cần org. */
@Controller('v1/permissions')
export class PermissionsController {
  constructor(private readonly registry: PermissionCatalogueRegistry) {}

  @Get()
  @ApiOk(PermissionListResponse)
  list() {
    const data = [...this.registry.merged().values()]
      .filter((e) => !e.deprecated)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => ({
        key: e.key,
        resource: e.resource,
        action: e.action,
        requires: [...e.requires],
        ownerOnly: e.ownerOnly,
        apiKeyEligible: e.apiKeyEligible,
        supportEligible: e.supportEligible,
      }));
    return serialize(PermissionListResponse, { data });
  }
}
