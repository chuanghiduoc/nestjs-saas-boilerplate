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
  Paginator,
  paginationConfig,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { OrgApiKeyService } from '../application/org-api-key.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import {
  NarrowingTenancyAction,
  OrgMemberOnly,
  SensitiveTenancyAction,
} from './decorators.js';
import {
  CreateOrgApiKeyBody,
  CreatedOrgApiKeyResponse,
  ListAcquisitionPage,
  OrgApiKeyResponse,
  orgApiKeyOf,
  publicIdOrNotFound,
} from './schemas.js';

/** Route `…/mine` khai báo TRƯỚC `…/{keyId}` (INT-M2). */
@Controller('v1/orgs/:orgId/api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: OrgApiKeyService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  /** Không `@Idempotent()` (S3-A8): response chứa secret và idempotency lưu body vào Redis. */
  @Post()
  @TenancyPermissions.require('api_keys.write_own')
  @SensitiveTenancyAction()
  @ApiOk(CreatedOrgApiKeyResponse)
  @ApiProblems(
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.PERMISSION_NOT_API_KEY_ELIGIBLE,
    TenancyErrors.MISSING_DEPENDENCIES,
    TenancyErrors.UNKNOWN_PERMISSION,
    TenancyErrors.API_KEYS_LIMIT,
    TenancyErrors.TTL_OUT_OF_RANGE,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateOrgApiKeyBody })
    body: z.infer<typeof CreateOrgApiKeyBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const { key, token } = await this.keys.create(body);
    const orgId = this.ctx.orgId();
    if (orgId === undefined)
      throw new Error('ApiKeysController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/api-keys/${key.publicId}`);
    // Secret một lần: không cache ở proxy/trình duyệt.
    res.setHeader('Cache-Control', 'no-store');
    return serialize(CreatedOrgApiKeyResponse, {
      ...orgApiKeyOf(key),
      key: token,
    });
  }

  @Get('mine')
  @OrgMemberOnly()
  @ApiOk(OrgApiKeyResponse)
  listMine(
    @Query({ schema: ListAcquisitionPage })
    page: z.infer<typeof ListAcquisitionPage>,
  ) {
    return this.page(page, true);
  }

  @Delete('mine/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgMemberOnly()
  @NarrowingTenancyAction()
  async revokeMine(@Param('keyId') keyId: string): Promise<void> {
    await this.keys.revokeMine(publicIdOrNotFound(keyId));
  }

  @Get()
  @TenancyPermissions.require('api_keys.read')
  @ApiOk(OrgApiKeyResponse)
  list(
    @Query({ schema: ListAcquisitionPage })
    page: z.infer<typeof ListAcquisitionPage>,
  ) {
    return this.page(page, false);
  }

  @Delete(':keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('api_keys.write_all')
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.ESCALATION_DENIED, TenancyErrors.OWNER_ONLY)
  async revoke(@Param('keyId') keyId: string): Promise<void> {
    await this.keys.revoke(publicIdOrNotFound(keyId));
  }

  private async page(page: z.infer<typeof ListAcquisitionPage>, mine: boolean) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=createdAt (ascending) is supported.',
      });
    const { rows, total } = await this.keys.list({
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
      mine,
    });
    return this.pages.offset(
      rows.map((k) => serialize(OrgApiKeyResponse, orgApiKeyOf(k))),
      page,
      total,
    );
  }
}
