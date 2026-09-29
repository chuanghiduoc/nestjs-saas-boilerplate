import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Query,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import type { ConfigOf } from '../../../core/config/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Paginator,
  etagOf,
  paginationConfig,
  serialize,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { MemberService } from '../application/member.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import {
  NarrowingTenancyAction,
  OrgMemberOnly,
  SensitiveTenancyAction,
} from './decorators.js';
import {
  ChangeRoleBody,
  ListMembersPage,
  MemberResponse,
  PublicIdParam,
  RoleFilterQuery,
  memberOf,
} from './schemas.js';

/** Id không phải UUID là "không có resource như vậy" (404), không phải lỗi SQL 22P02 (500). */
const idOrNotFound = (raw: string): string => {
  const r = PublicIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};

/** `me` khai báo TRƯỚC `:memberId` (Express khớp theo thứ tự đăng ký; spec SP3 §12). */
@Controller('v1/orgs/:orgId/members')
export class MembersController {
  constructor(
    private readonly members: MemberService,
    private readonly pages: Paginator,
    // `Paginator` giữ config ở `private readonly cfg` (SP1 `core/http/pagination.ts`): trần đếm đọc thẳng từ config (review I7).
    @Inject(paginationConfig.KEY)
    private readonly pagination: ConfigOf<typeof paginationConfig>,
  ) {}

  @Get('me')
  @OrgMemberOnly()
  @ApiOk(MemberResponse)
  async me(@Res({ passthrough: true }) res: HeaderWriter) {
    const m = await this.members.me();
    res.setHeader('ETag', etagOf(m.version));
    return serialize(MemberResponse, memberOf(m));
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgMemberOnly()
  @NarrowingTenancyAction()
  @ApiProblems(TenancyErrors.LAST_OWNER)
  async leave(): Promise<void> {
    await this.members.leave();
  }

  @Get()
  @TenancyPermissions.require('members.read')
  @ApiOk(MemberResponse)
  async list(
    @Query({ schema: ListMembersPage }) page: z.infer<typeof ListMembersPage>,
    @Query({ schema: RoleFilterQuery }) filter: z.infer<typeof RoleFilterQuery>,
  ) {
    if (page.sort?.direction === 'desc')
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        detail: 'Only sort=joinedAt (ascending) is supported.',
      });
    const { rows, total } = await this.members.list({
      roleId: filter.roleId,
      page: page.page,
      pageSize: page.pageSize,
      cap: this.pagination.totalCountCap,
    });
    return this.pages.offset(
      rows.map((m) => serialize(MemberResponse, memberOf(m))),
      page,
      total,
    );
  }

  @Get(':memberId')
  @TenancyPermissions.require('members.read')
  @ApiOk(MemberResponse)
  async get(
    @Param('memberId') memberId: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const m = await this.members.get(idOrNotFound(memberId));
    res.setHeader('ETag', etagOf(m.version));
    return serialize(MemberResponse, memberOf(m));
  }

  @Patch(':memberId')
  @TenancyPermissions.require('members.role.assign')
  @SensitiveTenancyAction()
  @ApiOk(MemberResponse)
  @ApiProblems(
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.CANNOT_CHANGE_OWN_ROLE,
    TenancyErrors.LAST_OWNER,
    CoreErrors.PRECONDITION_REQUIRED,
    CoreErrors.PRECONDITION_FAILED,
  )
  async changeRole(
    @Param('memberId') memberId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: ChangeRoleBody }) body: z.infer<typeof ChangeRoleBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const updated = await this.members.changeRole(
      idOrNotFound(memberId),
      ifMatch,
      body.roleId.toLowerCase(),
    );
    const view = await this.members.get(updated.publicId);
    res.setHeader('ETag', etagOf(view.version));
    return serialize(MemberResponse, memberOf(view));
  }

  @Delete(':memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('members.remove')
  @SensitiveTenancyAction()
  @ApiProblems(
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.LAST_OWNER,
  )
  async remove(@Param('memberId') memberId: string): Promise<void> {
    await this.members.remove(idOrNotFound(memberId));
  }
}
