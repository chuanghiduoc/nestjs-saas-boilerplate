import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  Paginator,
  paginationConfig,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { SupportGrantService } from '../application/support-grant.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import {
  NarrowingTenancyAction,
  SensitiveTenancyAction,
} from './decorators.js';
import {
  CreateSupportGrantBody,
  ListAcquisitionPage,
  SupportGrantResponse,
  publicIdOrNotFound,
  supportGrantOf,
} from './schemas.js';

@Controller('v1/orgs/:orgId/support-grants')
export class SupportGrantsController {
  constructor(
    private readonly grants: SupportGrantService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @TenancyPermissions.require('support_access.read')
  @ApiOk(SupportGrantResponse)
  async list(
    @Query({ schema: ListAcquisitionPage })
    page: z.infer<typeof ListAcquisitionPage>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=createdAt (ascending) is supported.',
      });
    const { rows, total } = await this.grants.list({
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
    });
    return this.pages.offset(
      rows.map((g) => serialize(SupportGrantResponse, supportGrantOf(g))),
      page,
      total,
    );
  }

  /** `@Idempotent()`: response không chứa secret (spec §9.7). */
  @Post()
  @Idempotent()
  @TenancyPermissions.require('support_access.grant')
  @SensitiveTenancyAction()
  @ApiOk(SupportGrantResponse)
  @ApiProblems(
    TenancyErrors.FEATURE_DISABLED,
    TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE,
    TenancyErrors.TTL_OUT_OF_RANGE,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateSupportGrantBody })
    body: z.infer<typeof CreateSupportGrantBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const g = await this.grants.grant({
      ...body,
      staffUserId: body.staffUserId.toLowerCase(),
    });
    const orgId = this.ctx.orgId();
    if (orgId === undefined)
      throw new Error(
        'SupportGrantsController.create ran without an org context',
      );
    setLocation(res, `/v1/orgs/${orgId}/support-grants/${g.publicId}`);
    return serialize(SupportGrantResponse, supportGrantOf(g));
  }

  @Delete(':grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('support_access.grant')
  @NarrowingTenancyAction()
  async revoke(@Param('grantId') grantId: string): Promise<void> {
    await this.grants.revoke(publicIdOrNotFound(grantId));
  }
}
