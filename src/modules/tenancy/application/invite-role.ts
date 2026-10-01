import { Injectable } from '@nestjs/common';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { assertCanBind, type Actor } from '../domain/escalation.js';
import { TenancyErrors } from '../errors.js';
import type { MemberRow } from '../ports/member-repository.js';
import { RoleRepository, type RoleRow } from '../ports/role-repository.js';
import { RolePermissions } from './authz/role-permissions.js';
import { EscalationGuard } from './escalation-guard.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

export const actorOfMember = (
  m: MemberRow,
  permissions: ReadonlySet<string>,
): Actor => ({
  memberRef: m.publicId,
  isOwner: m.systemKey === 'OWNER',
  permissions,
});

/**
 * Spec §8.4 đường (b), (c) lúc TẠO lời mời/link (dưới khoá org, actor đã đọc lại `FOR SHARE`): role phải thuộc org
 * (`422`), không bao giờ là OWNER (`422 owner_not_invitable`, S3-P5 — kể cả với owner; trigger `*_role_not_owner` là
 * lớp chặn cuối), và qua `assertCanBind` (luật 2, 2a theo tập, key orphan chỉ owner gán được).
 */
@Injectable()
export class InviteRole {
  constructor(
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly escalation: EscalationGuard,
  ) {}

  async bindable(rolePublicId: string, actor: Actor): Promise<RoleRow> {
    const role = await this.roles.findByPublicId(rolePublicId);
    if (!role)
      throw new AppError(CoreErrors.VALIDATION_FAILED, {
        fields: [
          {
            path: 'roleId',
            code: 'not_found',
            message: 'roleId is not a role of this organization',
          },
        ],
      });
    if (role.systemKey === 'OWNER')
      throw new AppError(TenancyErrors.OWNER_NOT_INVITABLE);
    const detail = await this.rolePermissions.detailOf(role);
    this.escalation.enforce(
      assertCanBind(
        actor,
        {
          systemKey: role.systemKey,
          permissions: new Set(detail.granted),
          orphans: detail.orphans,
        },
        this.registry.merged(),
      ),
    );
    return role;
  }
}
