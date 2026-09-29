import { Controller, Get } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { classifyTenantHandler } from '../../../../src/modules/tenancy/index.js';

@Controller('v1/orgs/:orgId/things')
class Tenant {
  @Get() list() {}
}
@Controller(['v1/orgs/:orgId/a', 'v1/public/a'])
class Mixed {
  @Get() list() {}
}
@Controller('v1/orgs/:id/things')
class WrongParam {
  @Get() list() {}
}
@Controller('v1/elsewhere')
class Other {
  @Get() list() {}
}

describe('classifyTenantHandler (spec SP4 §22.2 T2): the same matcher as OrgRouteInventory', () => {
  it.each([
    [Tenant, 'TENANT'],
    [Mixed, 'OTHER'],
    [WrongParam, 'INVALID'],
    [Other, 'OTHER'],
  ] as const)('%o → %s', (ctl, kind) => {
    expect(classifyTenantHandler(ctl, ctl.prototype.list)).toBe(kind);
  });
});
