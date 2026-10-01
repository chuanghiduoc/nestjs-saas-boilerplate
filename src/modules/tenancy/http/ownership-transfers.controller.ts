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
import { OwnershipTransferService } from '../application/ownership-transfer.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import {
  NarrowingTenancyAction,
  OrgMemberOnly,
  SensitiveTenancyAction,
} from './decorators.js';
import {
  CreateOwnershipTransferBody,
  ListAcquisitionPage,
  OwnershipTransferResponse,
  TransferStatusQuery,
  publicIdOrNotFound,
  transferOf,
} from './schemas.js';

@Controller('v1/orgs/:orgId/ownership-transfers')
export class OwnershipTransfersController {
  constructor(
    private readonly transfers: OwnershipTransferService,
    private readonly ctx: RequestContext,
    private readonly pages: Paginator,
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get()
  @OrgMemberOnly()
  @ApiOk(OwnershipTransferResponse)
  async list(
    @Query({ schema: ListAcquisitionPage })
    page: z.infer<typeof ListAcquisitionPage>,
    @Query({ schema: TransferStatusQuery })
    filter: z.infer<typeof TransferStatusQuery>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=createdAt (ascending) is supported.',
      });
    const { rows, total } = await this.transfers.list({
      status: filter.status,
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
    });
    return this.pages.offset(
      rows.map((t) => serialize(OwnershipTransferResponse, transferOf(t))),
      page,
      total,
    );
  }

  @Post()
  @TenancyPermissions.require('ownership.transfer')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OwnershipTransferResponse)
  @ApiProblems(
    TenancyErrors.OWNERSHIP_TRANSFER_PENDING,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateOwnershipTransferBody })
    body: z.infer<typeof CreateOwnershipTransferBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const t = await this.transfers.create({
      toMemberId: body.toMemberId.toLowerCase(),
      stepDownTo: body.stepDownTo,
    });
    const orgId = this.ctx.orgId();
    if (orgId === undefined)
      throw new Error(
        'OwnershipTransfersController.create ran without an org context',
      );
    setLocation(res, `/v1/orgs/${orgId}/ownership-transfers/${t.publicId}`);
    return serialize(
      OwnershipTransferResponse,
      transferOf({ ...t, status: 'PENDING' }),
    );
  }

  @Post(':transferId/accept')
  @HttpCode(HttpStatus.OK)
  @OrgMemberOnly()
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OwnershipTransferResponse)
  @ApiProblems(
    TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING,
    TenancyErrors.OWNERSHIP_TRANSFER_INVALIDATED,
    TenancyErrors.LAST_OWNER,
  )
  async accept(@Param('transferId') transferId: string) {
    const t = await this.transfers.accept(publicIdOrNotFound(transferId));
    return serialize(
      OwnershipTransferResponse,
      transferOf({ ...t, status: t.status }),
    );
  }

  @Post(':transferId/decline')
  @HttpCode(HttpStatus.OK)
  @OrgMemberOnly()
  @NarrowingTenancyAction()
  @Idempotent()
  @ApiOk(OwnershipTransferResponse)
  @ApiProblems(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING)
  async decline(@Param('transferId') transferId: string) {
    const t = await this.transfers.decline(publicIdOrNotFound(transferId));
    return serialize(
      OwnershipTransferResponse,
      transferOf({ ...t, status: t.status }),
    );
  }

  @Delete(':transferId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('ownership.transfer')
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.OWNERSHIP_TRANSFER_NOT_PENDING)
  async cancel(@Param('transferId') transferId: string): Promise<void> {
    await this.transfers.cancel(publicIdOrNotFound(transferId));
  }
}
