import { Controller, Get, Param } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { RolePermissions } from '../application/authz/role-permissions.js';
import { TenancyPermissions } from '../permissions.js';
import { RoleRepository } from '../ports/role-repository.js';
import {
  PublicIdParam,
  RoleListResponse,
  RoleResponse,
  roleOf,
} from './schemas.js';

/** 3A: chỉ role hệ thống, tập quyền tính trong code (spec SP3 §8.3). 3B thay bằng `RoleService` + route ghi. */
@Controller('v1/orgs/:orgId/roles')
export class RolesController {
  constructor(
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissions,
  ) {}

  @Get()
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleListResponse)
  async list() {
    const rows = await this.roles.list();
    const perms = await this.rolePermissions.ofMany(rows);
    return serialize(RoleListResponse, {
      data: rows.map((r) => roleOf(r, perms.get(r.id) ?? [])),
    });
  }

  @Get(':roleId')
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleResponse)
  async get(@Param('roleId') roleId: string) {
    const id = PublicIdParam.safeParse(roleId);
    const role = id.success
      ? await this.roles.findByPublicId(id.data.toLowerCase())
      : undefined;
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return serialize(
      RoleResponse,
      roleOf(role, await this.rolePermissions.of(role)),
    );
  }
}
