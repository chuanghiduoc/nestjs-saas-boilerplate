import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import {
  AppError,
  CoreErrors,
  type FieldError,
} from '../../../core/errors/index.js';
import { EventPublisher, userActor } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import {
  assertCanCreateRole,
  assertCanDeleteRole,
  assertCanEditRole,
  type Actor,
} from '../domain/escalation.js';
import { checkCustomRoleSet, sameSet } from '../domain/role.js';
import { TenancyErrors } from '../errors.js';
import {
  InviteLinkRevokedEvent,
  RoleCreatedEvent,
  RoleDeletedEvent,
  RoleUpdatedEvent,
} from '../events.js';
import { InvitationRepository } from '../ports/invitation-repository.js';
import { InviteLinkRepository } from '../ports/invite-link-repository.js';
import type { MemberRow } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { RoleRepository, type RoleRow } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { ActorReauthorizer } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { EscalationGuard } from './escalation-guard.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';

export type RoleView = { role: RoleRow; permissions: string[] };
export type RolePatch = {
  name?: string;
  description?: string | null;
  permissions?: readonly string[];
};
type CustomRole = RoleRow & { name: string };
const ROLES_WRITE = 'roles.write';

/**
 * Role tuỳ biến (spec SP3 §8.4 luật 1, 2a(i)–(iii), 6; §8.6): khoá org → khoá role `FOR NO KEY UPDATE` → đọc lại actor
 * `FOR SHARE` và kiểm lại cửa → kiểm tập mới → luật → ghi → outbox, trong MỘT transaction. Trigger guard/closure và FK
 * `RESTRICT` là lớp chặn cuối. Mọi mutation là `@SensitiveTenancyAction()` ở controller.
 */
@Injectable()
export class RoleService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly roles: RoleRepository,
    private readonly rolePermissions: RolePermissions,
    private readonly reauth: ActorReauthorizer,
    private readonly escalation: EscalationGuard,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    private readonly invitations: InvitationRepository,
    private readonly links: InviteLinkRepository,
  ) {}

  async list(): Promise<RoleView[]> {
    const rows = await this.roles.list();
    const perms = await this.rolePermissions.ofMany(rows);
    return rows.map((role) => ({
      role,
      permissions: perms.get(role.id) ?? [],
    }));
  }

  async get(publicId: string): Promise<RoleView> {
    const role = await this.roles.findByPublicId(publicId);
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return { role, permissions: await this.rolePermissions.of(role) };
  }

  async create(input: {
    name: string;
    description: string | null;
    permissions: readonly string[];
  }): Promise<RoleView> {
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor, permissions } = await this.reauth.require([ROLES_WRITE]);
      const next = this.validated(input.permissions);
      this.escalation.enforce(
        assertCanCreateRole(
          this.actorOf(actor, permissions),
          next,
          this.registry.merged(),
        ),
      );
      const role = await this.roles.insertCustom({
        name: input.name,
        description: input.description,
      });
      await this.roles.replacePermissions(role.id, next);
      const keys = [...next].sort();
      await this.events.publish(RoleCreatedEvent, {
        data: { roleId: role.publicId, permissions: keys },
        aggregate: { type: 'role', id: role.publicId, version: role.version },
        actor: userActor(this.ctx, 'tenancy'),
      });
      return { role, permissions: keys };
    });
  }

  async update(
    publicId: string,
    ifMatch: string | undefined,
    patch: RolePatch,
  ): Promise<RoleView> {
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const locked = await this.lockRole(publicId);
      const { actor, permissions } = await this.reauth.require([ROLES_WRITE]);
      const role = this.customOnly(locked);
      assertIfMatch(ifMatch, role.version, { required: true });
      // Tập cũ cho luật 1/2a là tập ĐÃ CẤP (key orphan không cấp gì, R-X23); `validated` từ chối thêm key orphan (422
      // unknown_permission) vì nó không có trong catalogue gộp.
      const stored = await this.rolePermissions.detailOf(role);
      const oldSet: ReadonlySet<string> = new Set(stored.granted);
      const newSet =
        patch.permissions === undefined
          ? oldSet
          : this.validated(patch.permissions);
      this.escalation.enforce(
        assertCanEditRole(
          this.actorOf(actor, permissions),
          { heldByActor: actor.roleId === role.id, oldSet, newSet },
          this.registry.merged(),
        ),
      );
      const name = patch.name ?? role.name;
      const description =
        patch.description === undefined ? role.description : patch.description;
      // R-X23: PATCH có `permissions` luôn gỡ key orphan còn lưu (tập mới đã qua catalogue nên không chứa orphan), kể cả khi
      // tập đã cấp không đổi — đó là cách owner dọn role sau khi tắt module.
      const permissionsChanged =
        patch.permissions !== undefined &&
        (!sameSet(oldSet, newSet) || stored.orphans.length > 0);
      // Review Focus 2: không đổi gì → không tăng version, không event, không ghi dòng.
      if (
        !permissionsChanged &&
        name === role.name &&
        description === role.description
      )
        return { role, permissions: [...oldSet].sort() };
      if (permissionsChanged)
        await this.roles.replacePermissions(role.id, newSet);
      const updated = await this.roles.update(role.id, { name, description });
      const keys = [...newSet].sort();
      await this.events.publish(RoleUpdatedEvent, {
        data: { roleId: updated.publicId, permissions: keys },
        aggregate: {
          type: 'role',
          id: updated.publicId,
          version: updated.version,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
      return { role: updated, permissions: keys };
    });
  }

  async delete(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      const locked = await this.lockRole(publicId);
      const { actor, permissions } = await this.reauth.require([ROLES_WRITE]);
      const role = this.customOnly(locked);
      const oldSet: ReadonlySet<string> = new Set(
        await this.rolePermissions.of(role),
      );
      this.escalation.enforce(
        assertCanDeleteRole(
          this.actorOf(actor, permissions),
          oldSet,
          this.registry.merged(),
        ),
      );
      // 3C (spec Bảng 5, §6.7, §6.8, R-18): lời mời PENDING đã hết hạn của role → EXPIRED (trạng thái suy ra từ thời gian,
      // không event); link chưa thu hồi mà không còn mở → thu hồi + `tenancy.invite_link.revoked { ROLE_DELETED }` từng link
      // (ghi `revoked_at` là thay đổi thật, DB2-M3). Lời mời PENDING còn hạn / link đang mở còn lại làm `SET NULL (role_id)`
      // vi phạm `*_pending_role_ck` / `*_active_role_ck` → 409 role_in_use (R-11, B-15, T-9).
      await this.invitations.expireLapsedForRole(role.id);
      for (const l of await this.links.revokeClosedForRole(role.id))
        await this.events.publish(InviteLinkRevokedEvent, {
          data: { inviteLinkId: l.publicId, reason: 'ROLE_DELETED' },
          aggregate: {
            type: 'invite_link',
            id: l.publicId,
            version: l.version,
          },
          actor: userActor(this.ctx, 'tenancy'),
        });
      await this.roles.deleteById(role.id); // còn member → 23001 org_members_role_fk → 409 role_in_use (T-9)
      await this.events.publish(RoleDeletedEvent, {
        data: { roleId: role.publicId },
        aggregate: {
          type: 'role',
          id: role.publicId,
          version: role.version + 1,
        },
        actor: userActor(this.ctx, 'tenancy'),
      });
    });
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt)
      throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12
  }

  /** Thứ tự khoá cố định (spec §3.14): org (đã khoá) → role → member (`ActorReauthorizer`, `FOR SHARE`). */
  private async lockRole(publicId: string): Promise<RoleRow> {
    const role = await this.roles.lockByPublicId(publicId);
    if (!role) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // R-13: role của org khác không thấy được
    return role;
  }

  private customOnly(role: RoleRow): CustomRole {
    if (role.systemKey !== null)
      throw new AppError(TenancyErrors.SYSTEM_ROLE_IMMUTABLE); // R-10
    if (role.name === null)
      throw new Error('a custom role without a name (org_roles_kind_ck)');
    return { ...role, name: role.name };
  }

  private actorOf(actor: MemberRow, permissions: ReadonlySet<string>): Actor {
    return {
      memberRef: actor.publicId,
      isOwner: actor.systemKey === 'OWNER',
      permissions,
    };
  }

  /** Luật 1 phần "tập hợp lệ" → 422 có danh sách key (spec §15: `errors[]` liệt kê key). */
  private validated(keys: readonly string[]): ReadonlySet<string> {
    const check = checkCustomRoleSet(keys, this.registry.merged());
    if (check.ok) return check.permissions;
    const fields = (code: string): FieldError[] =>
      check.keys.map((key) => ({ path: 'permissions', code, message: key }));
    switch (check.reason) {
      case 'UNKNOWN_PERMISSION':
        throw new AppError(TenancyErrors.UNKNOWN_PERMISSION, {
          fields: fields('unknown_permission'),
        });
      case 'PERMISSION_NOT_DELEGABLE':
        throw new AppError(TenancyErrors.PERMISSION_NOT_DELEGABLE, {
          fields: fields('permission_not_delegable'),
        });
      case 'MISSING_DEPENDENCIES':
        throw new AppError(TenancyErrors.MISSING_DEPENDENCIES, {
          fields: fields('missing_dependency'),
        });
      default: {
        const unknown: never = check.reason;
        throw new Error(`unknown role set problem ${String(unknown)}`);
      }
    }
  }
}
