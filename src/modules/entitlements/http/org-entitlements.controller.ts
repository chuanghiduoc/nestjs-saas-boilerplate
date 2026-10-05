import { Controller, Get } from '@nestjs/common';
import { CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, ApiProblems, serialize } from '../../../core/http/index.js';
import { EntitlementCatalogueRegistry } from '../application/entitlement-catalogue.registry.js';
import { OrgEntitlementsQuery } from '../application/org-entitlements.query.js';
import { EntitlementPermissions } from '../permissions.js';
import { OrgEntitlementsResponse, orgEntitlementsOf } from './schemas.js';

/**
 * Spec §12.1: org từ `ctx.orgId()` (middleware của SP3), không ETag (usage đổi mà `version` không đổi), không mutation
 * nên không cần marker G-8. Không có API tenant nào ghi entitlement (S4-D18).
 */
@Controller('v1/orgs/:orgId/entitlements')
export class OrgEntitlementsController {
  constructor(
    private readonly query: OrgEntitlementsQuery,
    private readonly registry: EntitlementCatalogueRegistry,
  ) {}

  @Get()
  @EntitlementPermissions.require('entitlements.read')
  @ApiOk(OrgEntitlementsResponse)
  @ApiProblems(
    CoreErrors.FORBIDDEN,
    CoreErrors.NOT_FOUND,
    CoreErrors.SERVICE_UNAVAILABLE,
  )
  async get() {
    const { snapshot, usage } = await this.query.read();
    return serialize(
      OrgEntitlementsResponse,
      orgEntitlementsOf(snapshot, this.registry.features(), usage),
    );
  }
}
