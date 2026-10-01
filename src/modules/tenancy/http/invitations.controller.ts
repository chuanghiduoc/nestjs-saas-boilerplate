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
import { InvitationService } from '../application/invitation.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import {
  NarrowingTenancyAction,
  SensitiveTenancyAction,
} from './decorators.js';
import {
  CreateInvitationBody,
  InvitationResponse,
  ListAcquisitionPage,
  invitationOf,
  publicIdOrNotFound,
} from './schemas.js';

/** Spec SP3 §12: lời mời của org; org lấy từ context, không từ param. */
@Controller('v1/orgs/:orgId/invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @TenancyPermissions.require('invitations.read')
  @ApiOk(InvitationResponse)
  async list(
    @Query({ schema: ListAcquisitionPage })
    page: z.infer<typeof ListAcquisitionPage>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=createdAt (ascending) is supported.',
      });
    const { rows, total } = await this.invitations.list({
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
    });
    return this.pages.offset(
      rows.map((i) => serialize(InvitationResponse, invitationOf(i))),
      page,
      total,
    );
  }

  @Post()
  @TenancyPermissions.require('invitations.write')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(InvitationResponse)
  @ApiProblems(
    TenancyErrors.FEATURE_DISABLED,
    TenancyErrors.OWNER_NOT_INVITABLE,
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.PENDING_INVITATIONS_LIMIT,
    TenancyErrors.INVITATION_PENDING_EXISTS,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateInvitationBody })
    body: z.infer<typeof CreateInvitationBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const inv = await this.invitations.create({
      email: body.email,
      roleId: body.roleId.toLowerCase(),
    });
    const orgId = this.ctx.orgId();
    if (orgId === undefined)
      throw new Error(
        'InvitationsController.create ran without an org context',
      );
    // Spec §12 không có GET một lời mời: `Location` là URL định danh resource (đích của DELETE).
    setLocation(res, `/v1/orgs/${orgId}/invitations/${inv.publicId}`);
    return serialize(
      InvitationResponse,
      invitationOf({ ...inv, status: 'PENDING' }),
    );
  }

  @Delete(':invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('invitations.write')
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.INVITATION_NOT_PENDING)
  async revoke(@Param('invitationId') invitationId: string): Promise<void> {
    await this.invitations.revoke(publicIdOrNotFound(invitationId));
  }
}
