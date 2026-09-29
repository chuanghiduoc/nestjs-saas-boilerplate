import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { z } from 'zod';
import { RequestContext } from '../../../core/context/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  ApiOk,
  ApiProblems,
  Idempotent,
  etagOf,
  serialize,
  setLocation,
  type HeaderWriter,
} from '../../../core/http/index.js';
import { RoleService, type RoleView } from '../application/role.service.js';
import { TenancyErrors } from '../errors.js';
import { TenancyPermissions } from '../permissions.js';
import { SensitiveTenancyAction } from './decorators.js';
import {
  CreateRoleBody,
  PatchRoleBody,
  PublicIdParam,
  RoleListResponse,
  RoleResponse,
  roleOf,
} from './schemas.js';

/** Id không phải UUID là "không có role như vậy" (404), không phải 22P02 (500) — Review Focus 5. */
const idOrNotFound = (raw: string): string => {
  const r = PublicIdParam.safeParse(raw);
  if (!r.success) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
  return r.data.toLowerCase();
};
const viewOf = (v: RoleView) => roleOf(v.role, v.permissions);
const ROLE_WRITE_PROBLEMS = [
  TenancyErrors.OWNER_ONLY,
  TenancyErrors.ESCALATION_DENIED,
  TenancyErrors.MISSING_DEPENDENCIES,
  TenancyErrors.UNKNOWN_PERMISSION,
  TenancyErrors.PERMISSION_NOT_DELEGABLE,
] as const;

/** Spec SP3 §12: role hệ thống chỉ đọc; role tuỳ biến tạo/sửa/xoá bằng `roles.write`. Org lấy từ context, không từ param. */
@Controller('v1/orgs/:orgId/roles')
export class RolesController {
  constructor(
    private readonly roles: RoleService,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleListResponse)
  async list() {
    return serialize(RoleListResponse, {
      data: (await this.roles.list()).map(viewOf),
    });
  }

  @Get(':roleId')
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleResponse)
  async get(
    @Param('roleId') roleId: string,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const v = await this.roles.get(idOrNotFound(roleId));
    res.setHeader('ETag', etagOf(v.role.version));
    return serialize(RoleResponse, viewOf(v));
  }

  @Post()
  @TenancyPermissions.require('roles.write')
  @SensitiveTenancyAction()
  @Idempotent()
  @ApiOk(RoleResponse)
  @ApiProblems(
    ...ROLE_WRITE_PROBLEMS,
    TenancyErrors.ROLE_NAME_TAKEN,
    CoreErrors.VALIDATION_FAILED,
  )
  async create(
    @Body({ schema: CreateRoleBody }) body: z.infer<typeof CreateRoleBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const v = await this.roles.create(body);
    const orgId = this.ctx.orgId();
    if (orgId === undefined)
      throw new Error('RolesController.create ran without an org context');
    setLocation(res, `/v1/orgs/${orgId}/roles/${v.role.publicId}`);
    res.setHeader('ETag', etagOf(v.role.version));
    return serialize(RoleResponse, viewOf(v));
  }

  @Patch(':roleId')
  @TenancyPermissions.require('roles.write')
  @SensitiveTenancyAction()
  @ApiOk(RoleResponse)
  @ApiProblems(
    ...ROLE_WRITE_PROBLEMS,
    TenancyErrors.CANNOT_EDIT_OWN_ROLE,
    TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
    TenancyErrors.ROLE_NAME_TAKEN,
    CoreErrors.PRECONDITION_REQUIRED,
    CoreErrors.PRECONDITION_FAILED,
  )
  async update(
    @Param('roleId') roleId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: PatchRoleBody }) body: z.infer<typeof PatchRoleBody>,
    @Res({ passthrough: true }) res: HeaderWriter,
  ) {
    const v = await this.roles.update(idOrNotFound(roleId), ifMatch, body);
    res.setHeader('ETag', etagOf(v.role.version));
    return serialize(RoleResponse, viewOf(v));
  }

  @Delete(':roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenancyPermissions.require('roles.write')
  @SensitiveTenancyAction()
  @ApiProblems(
    TenancyErrors.OWNER_ONLY,
    TenancyErrors.ESCALATION_DENIED,
    TenancyErrors.ROLE_IN_USE,
    TenancyErrors.SYSTEM_ROLE_IMMUTABLE,
  )
  async remove(@Param('roleId') roleId: string): Promise<void> {
    await this.roles.delete(idOrNotFound(roleId));
  }
}
