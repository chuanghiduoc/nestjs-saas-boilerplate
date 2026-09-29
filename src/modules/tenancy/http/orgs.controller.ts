import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { z } from 'zod';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  Paginator,
  etagOf,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { OrgService } from '../application/org.service.js';
import { TenancyErrors } from '../errors.js';
import { SensitiveTenancyAction } from './decorators.js';
import {
  CreateOrgBody,
  IncludeDeletedQuery,
  ListOrgsPage,
  OrgListItem,
  OrganizationResponse,
  organizationOf,
  orgListItemOf,
} from './schemas.js';

/** Route ngoài path org (spec SP3 §7.2): không qua `OrgContextMiddleware`; service tự vào OrgScope. */
@Controller('v1/orgs')
export class OrgsController {
  constructor(
    private readonly orgs: OrgService,
    private readonly pages: Paginator,
  ) {}

  @Post()
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(OrganizationResponse)
  @ApiProblems(
    TenancyErrors.ORG_CREATION_DISABLED,
    TenancyErrors.ORG_LIMIT_REACHED,
    TenancyErrors.ALREADY_IN_AN_ORG,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateOrgBody }) body: z.infer<typeof CreateOrgBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const org = await this.orgs.create(body);
    setLocation(res, `/v1/orgs/${org.id}`);
    res.setHeader('ETag', etagOf(org.version));
    return serialize(OrganizationResponse, organizationOf(org));
  }

  @Get()
  @ApiOk(OrgListItem)
  async list(
    @Query({ schema: ListOrgsPage }) page: z.infer<typeof ListOrgsPage>,
    @Query({ schema: IncludeDeletedQuery })
    flags: z.infer<typeof IncludeDeletedQuery>,
  ) {
    // Hàm definer sắp theo thời điểm tham gia (m.created_at, m.id); chiều giảm không hỗ trợ.
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=joinedAt (ascending) is supported.',
      });
    const { rows, total } = await this.orgs.list({
      includeDeleted: flags.includeDeleted,
      page: page.page,
      pageSize: page.pageSize,
    });
    return this.pages.offset(
      rows.map((r) => serialize(OrgListItem, orgListItemOf(r))),
      page,
      total,
    );
  }
}
