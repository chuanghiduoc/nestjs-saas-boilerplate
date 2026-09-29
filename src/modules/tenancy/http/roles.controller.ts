import { Controller, Get, Param } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { ApiOk, serialize } from '../../../core/http/index.js';
import { effectivePermissions } from '../application/authz/effective-permissions.js';
import { PermissionCatalogueRegistry } from '../application/permission-catalogue.registry.js';
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
    private readonly registry: PermissionCatalogueRegistry,
  ) {}

  @Get()
  @TenancyPermissions.require('roles.read')
  @ApiOk(RoleListResponse)
  async list() {
    const merged = this.registry.merged();
    const data = (await this.roles.list()).map((r) =>
      roleOf(r, effectivePermissions(r, merged)),
    );
    return serialize(RoleListResponse, { data });
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
      roleOf(role, effectivePermissions(role, this.registry.merged())),
    );
  }
}
