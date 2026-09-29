import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import { CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  etagOf,
  serialize,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { OrgLifecycleService } from '../application/org-lifecycle.service.js';
import { OrgService } from '../application/org.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { SensitiveTenancyAction } from './decorators.js';
import {
  OrganizationResponse,
  PatchOrgBody,
  organizationOf,
} from './schemas.js';

/** Org lấy từ `ctx.orgId()` (middleware), không từ `@Param('orgId')` (spec SP3 §7.1 bước 3.3). */
@Controller('v1/orgs/:orgId')
export class OrgController {
  constructor(
    private readonly orgs: OrgService,
    private readonly lifecycle: OrgLifecycleService,
  ) {}

  @Get()
  @TenancyPermissions.require('org.read')
  @ApiOk(OrganizationResponse)
  async get(@Res({ passthrough: true }) res: HeaderWriter) {
    const org = await this.orgs.get();
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }

  @Patch()
  @TenancyPermissions.require('org.update')
  @SensitiveTenancyAction()
  @ApiOk(OrganizationResponse)
  @ApiProblems(
    CoreErrors.PRECONDITION_REQUIRED,
    CoreErrors.PRECONDITION_FAILED,
    CoreErrors.VALIDATION_FAILED,
  )
  async rename(
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchOrgBody }) body: z.infer<typeof PatchOrgBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    // Merge-patch (SP1): `null` chỉ hợp lệ ở member nullable, nên `name: null` đã bị schema từ chối (422); vắng = giữ nguyên.
    const org = await this.orgs.rename(ifMatch, body.name);
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('org.delete')
  @SensitiveTenancyAction()
  async softDelete(): Promise<void> {
    await this.lifecycle.softDelete({ kind: 'MEMBER' });
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @TenancyPermissions.require('org.restore')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OrganizationResponse)
  @ApiProblems(TenancyErrors.ORG_NOT_DELETED, TenancyErrors.LAST_OWNER)
  async restore(@Res({ passthrough: true }) res: HeaderWriter) {
    const org = await this.lifecycle.restore({ kind: 'MEMBER' });
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }
}
