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
import { InviteLinkService } from '../application/invite-link.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import {
  NarrowingTenancyAction,
  SensitiveTenancyAction,
} from './decorators.js';
import {
  CreateInviteLinkBody,
  CreatedInviteLinkResponse,
  InviteLinkResponse,
  ListAcquisitionPage,
  inviteLinkOf,
  publicIdOrNotFound,
} from './schemas.js';

@Controller('v1/orgs/:orgId/invite-links')
export class InviteLinksController {
  constructor(
    private readonly links: InviteLinkService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @TenancyPermissions.require('invitations.read')
  @ApiOk(InviteLinkResponse)
  async list(
    @Query({ schema: ListAcquisitionPage })
    page: z.infer<typeof ListAcquisitionPage>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=createdAt (ascending) is supported.',
      });
    const { rows, total } = await this.links.list({
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
    });
    return this.pages.offset(
      rows.map((l) => serialize(InviteLinkResponse, inviteLinkOf(l))),
      page,
      total,
    );
  }

  /** Không `@Idempotent()` (S3-A8, amendment B9): response chứa secret và idempotency lưu body vào Redis. */
  @Post()
  @TenancyPermissions.require('invitations.write')
  @SensitiveTenancyAction()
  @ApiOk(CreatedInviteLinkResponse)
  @ApiProblems(
    TenancyErrors.FEATURE_DISABLED,
    TenancyErrors.OWNER_NOT_INVITABLE,
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.INVITE_LINKS_LIMIT,
    TenancyErrors.TTL_OUT_OF_RANGE,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateInviteLinkBody })
    body: z.infer<typeof CreateInviteLinkBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const { link, url } = await this.links.create({
      roleId: body.roleId.toLowerCase(),
      maxUses: body.maxUses,
      expiresAt: new Date(body.expiresAt),
    });
    const orgId = this.ctx.orgId();
    if (orgId === undefined)
      throw new Error(
        'InviteLinksController.create ran without an org context',
      );
    setLocation(res, `/v1/orgs/${orgId}/invite-links/${link.publicId}`);
    // Secret một lần: không cache ở proxy/trình duyệt.
    res.setHeader('Cache-Control', 'no-store');
    return serialize(CreatedInviteLinkResponse, {
      ...inviteLinkOf({ ...link, status: 'ACTIVE' }),
      url,
    });
  }

  @Delete(':linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('invitations.write')
  @NarrowingTenancyAction()
  async revoke(@Param('linkId') linkId: string): Promise<void> {
    await this.links.revoke(publicIdOrNotFound(linkId));
  }
}
