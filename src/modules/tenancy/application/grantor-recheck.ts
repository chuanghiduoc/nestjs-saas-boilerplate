import { Injectable } from '@nestjs/common';
import type { SystemRoleKey } from '../constants.js';
import { assertCanBind, type Actor } from '../domain/escalation.js';
import type { InvalidationReason } from '../domain/invitation.js';
import { MemberRepository } from '../ports/member-repository.js';
import { RolePermissions } from './authz/role-permissions.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

const INVITATIONS_WRITE = 'invitations.write';
export type GrantorCheck =
  { ok: true } | { ok: false; reason: InvalidationReason };

/**
 * Spec SP3 §8.4 đường (b), (c) (SEC-M3): lúc chấp nhận lời mời / join link, kiểm lại CỬA (`invitations.write`) và TRẦN
 * (`assertCanBind`, gồm luật 2a theo tập) với người mời/người tạo HIỆN TẠI. Gọi trong transaction đã khoá org; đọc
 * người đó `FOR SHARE` (thứ tự khoá §3.14: org → tenancy_users → lời mời/link → member).
 */
@Injectable()
export class GrantorRecheck {
  constructor(
    private readonly members: MemberRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly registry: PermissionCatalogueRegistry,
  ) {}

  async check(
    grantorMemberId: string | null,
    role: { id: string; systemKey: SystemRoleKey | null },
  ): Promise<GrantorCheck> {
    if (grantorMemberId === null) return { ok: false, reason: 'INVITER_GONE' };
    const [grantor] = await this.members.lockForShare([grantorMemberId]);
    if (!grantor) return { ok: false, reason: 'INVITER_GONE' };
    const permissions = new Set(
      await this.rolePermissions.of({
        id: grantor.roleId,
        systemKey: grantor.systemKey,
      }),
    );
    if (!permissions.has(INVITATIONS_WRITE))
      return { ok: false, reason: 'INVITER_LACKS_GATE' };
    const actor: Actor = {
      memberRef: grantor.publicId,
      isOwner: grantor.systemKey === 'OWNER',
      permissions,
    };
    // 3B: `orphans` bắt buộc — role còn key orphan chỉ owner gán được, kể cả lúc kiểm lại (R-X23, final review 3B I-1).
    const detail = await this.rolePermissions.detailOf(role);
    const target = {
      systemKey: role.systemKey,
      permissions: new Set(detail.granted),
      orphans: detail.orphans,
    };
    return assertCanBind(actor, target, this.registry.merged()).ok
      ? { ok: true }
      : { ok: false, reason: 'INVITER_NOT_DOMINANT' };
  }
}
