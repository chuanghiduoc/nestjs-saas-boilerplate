import { Controller, Get, Module, Post } from '@nestjs/common';
import { RequestContext } from '../../../../src/core/context/index.js';
import { Idempotent } from '../../../../src/core/http/index.js';
import { TenancyPermissions } from '../../../../src/modules/tenancy/permissions.js';

/** Route tenant giả của `features/` (không thuộc module tenancy nên không vào luật G-8): quan sát context của request. */
@Controller('v1/orgs/:orgId/probe')
class ProbeController {
  private created = 0;
  constructor(private readonly ctx: RequestContext) {}

  @Get()
  @TenancyPermissions.require('org.read')
  read() {
    const a = this.ctx.orgAccess();
    return {
      orgId: this.ctx.orgId(),
      via: a?.via,
      ref: a?.ref,
      permissions: a?.permissions,
    };
  }

  @Get('owner-only')
  @TenancyPermissions.require('org.delete')
  ownerOnly() {
    return { ok: true };
  }

  @Post('idem')
  @Idempotent()
  @TenancyPermissions.require('org.read')
  idem() {
    this.created += 1;
    return { n: this.created, orgId: this.ctx.orgId() };
  }
}
@Module({ controllers: [ProbeController] })
export class TenancyProbeModule {}
