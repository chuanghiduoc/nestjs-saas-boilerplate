import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { assertIfMatch } from '../../../core/http/index.js';
import {
  IdentityDirectory,
  identityConfig,
  type DirectoryUser,
} from '../../identity/index.js';
import {
  assertCanBind,
  assertCanManage,
  assertNotSelf,
  type Actor,
} from '../domain/escalation.js';
import { MemberRemovedEvent, MemberRoleChangedEvent } from '../events.js';
import {
  MemberRepository,
  type MemberRow,
} from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { RoleRepository } from '../ports/role-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { ActorReauthorizer, userActor } from './actor-reauthorizer.js';
import { RolePermissions } from './authz/role-permissions.js';
import { EscalationGuard } from './escalation-guard.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyMetrics, type LastOwnerPath } from './tenancy-metrics.js';
import { TransferSettlement } from './transfer-settlement.js';

export type MemberView = MemberRow & {
  email: string | null;
  name: string | null;
};
const LAST_OWNER_CONSTRAINT = 'org_members_last_owner_ck';

/**
 * Mutation member (spec SP3 §8.4, §8.6): khoá org → đọc target → đọc lại actor + target `FOR SHARE` (id tăng dần) → kiểm
 * lại cửa → luật 3, 4/2a(v)/5, 2/2a(iv)/5 → ghi → outbox. Trigger hoãn owner cuối là lớp chặn cuối (T-1, T-28).
 */
@Injectable()
export class MemberService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly roles: RoleRepository,
    private readonly reauth: ActorReauthorizer,
    private readonly escalation: EscalationGuard,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly rolePermissions: RolePermissions,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    private readonly metrics: TenancyMetrics,
    private readonly settlement: TransferSettlement,
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  async me(): Promise<MemberView> {
    const ref = this.ctx.orgAccess()?.ref;
    const row =
      ref === undefined ? undefined : await this.members.findByPublicId(ref);
    if (!row) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return (await this.withProfiles([row]))[0] ?? this.orphan(row);
  }

  async list(q: {
    roleId?: string;
    page: number;
    pageSize: number;
    cap: number;
  }): Promise<{ rows: MemberView[]; total: number }> {
    let roleId: string | undefined;
    if (q.roleId !== undefined) {
      const role = await this.roles.findByPublicId(q.roleId);
      if (!role) return { rows: [], total: 0 };
      roleId = role.id;
    }
    const [rows, total] = await Promise.all([
      this.members.list({
        roleId,
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
      }),
      this.members.countUpTo(roleId, q.cap),
    ]);
    return { rows: await this.withProfiles(rows), total };
  }

  async get(memberId: string): Promise<MemberView> {
    const row = await this.members.findByPublicId(memberId);
    if (!row) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
    return (await this.withProfiles([row]))[0] ?? this.orphan(row);
  }

  async changeRole(
    memberId: string,
    ifMatch: string | undefined,
    rolePublicId: string,
  ): Promise<MemberRow> {
    await this.hooks.afterGuard();
    return this.lastOwnerGuarded('demote', () =>
      this.uow.run(async () => {
        await this.lockActiveOrg();
        const target = await this.members.findByPublicId(memberId);
        if (!target)
          throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const { actor, permissions, locked } = await this.reauth.require(
          ['members.role.assign'],
          [target.id],
        );
        const current = locked.find((m) => m.id === target.id);
        if (!current)
          throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
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
        assertIfMatch(ifMatch, current.version, { required: true });
        const merged = this.registry.merged();
        const me: Actor = {
          memberRef: actor.publicId,
          isOwner: actor.systemKey === 'OWNER',
          permissions,
        };
        this.escalation.enforce(assertNotSelf(me, current.publicId));
        this.escalation.enforce(
          assertCanManage(
            me,
            {
              memberRef: current.publicId,
              isOwner: current.systemKey === 'OWNER',
              permissions: new Set(
                await this.rolePermissions.of({
                  id: current.roleId,
                  systemKey: current.systemKey,
                }),
              ),
            },
            merged,
          ),
        );
        const bound = await this.rolePermissions.detailOf(role);
        this.escalation.enforce(
          assertCanBind(
            me,
            {
              systemKey: role.systemKey,
              permissions: new Set(bound.granted),
              orphans: bound.orphans,
            },
            merged,
          ),
        );
        if (role.id === current.roleId) return current;
        const updated = await this.members.changeRole(current.id, role.id);
        await this.events.publish(MemberRoleChangedEvent, {
          data: {
            memberId: updated.publicId,
            userId: updated.userPublicId,
            fromRoleId: current.rolePublicId,
            toRoleId: updated.rolePublicId,
            reason: 'ASSIGNED',
          },
          aggregate: {
            type: 'member',
            id: updated.publicId,
            version: updated.version,
          },
          actor: userActor(this.ctx),
        });
        return updated;
      }),
    );
  }

  async remove(memberId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.lastOwnerGuarded('remove', () =>
      this.uow.run(async () => {
        await this.lockActiveOrg();
        const target = await this.members.findByPublicId(memberId);
        if (!target)
          throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const { actor, permissions, locked } = await this.reauth.require(
          ['members.remove'],
          [target.id],
        );
        const current = locked.find((m) => m.id === target.id);
        if (!current)
          throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const merged = this.registry.merged();
        const me: Actor = {
          memberRef: actor.publicId,
          isOwner: actor.systemKey === 'OWNER',
          permissions,
        };
        this.escalation.enforce(
          assertCanManage(
            me,
            {
              memberRef: current.publicId,
              isOwner: current.systemKey === 'OWNER',
              permissions: new Set(
                await this.rolePermissions.of({
                  id: current.roleId,
                  systemKey: current.systemKey,
                }),
              ),
            },
            merged,
          ),
        );
        await this.deleteWithEvent(current, 'REMOVED');
      }),
    );
  }

  /** Rời org (`@NarrowingTenancyAction()`): không cần session mới; owner cuối → 409 `last_owner` (trigger). */
  async leave(): Promise<void> {
    await this.lastOwnerGuarded('leave', () =>
      this.uow.run(async () => {
        await this.lockActiveOrg();
        const { actor } = await this.reauth.require([]);
        await this.deleteWithEvent(actor, 'LEFT');
      }),
    );
  }

  private async deleteWithEvent(
    m: MemberRow,
    reason: 'REMOVED' | 'LEFT',
  ): Promise<void> {
    // 3C (spec §9.3): huỷ chuyển quyền PENDING của member TRƯỚC câu xoá (không thì `…_pending_members_ck` làm transaction
    // fail to); quá hạn → EXPIRED không event. 3D: phát `api_key.revoked` từng key (spec Bảng 5).
    await this.settlement.settleForRemovedMember(m.id, userActor(this.ctx));
    await this.members.deleteById(m.id);
    await this.events.publish(MemberRemovedEvent, {
      data: {
        memberId: m.publicId,
        userId: m.userPublicId,
        roleId: m.rolePublicId,
        reason,
      },
      aggregate: { type: 'member', id: m.publicId, version: m.version + 1 },
      actor: userActor(this.ctx),
    });
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt)
      throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12, O-10
  }

  /** Trigger owner cuối bắn lúc COMMIT; 409 do constraint map, ở đây chỉ đếm metric theo đường. */
  private async lastOwnerGuarded<T>(
    path: LastOwnerPath,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgFields(err)?.constraint === LAST_OWNER_CONSTRAINT)
        this.metrics.lastOwnerBlocked.add(1, { path });
      throw err;
    }
  }

  /** Email/tên qua `IdentityDirectory.findUsers` một lần mỗi trang (local/hybrid); `external` → `null` (spec §11). */
  private async withProfiles(
    rows: readonly MemberRow[],
  ): Promise<MemberView[]> {
    const ids = rows.flatMap((r) => (r.authUserId ? [r.authUserId] : []));
    const users: DirectoryUser[] =
      this.identity.mode === 'external' || !this.directory || ids.length === 0
        ? []
        : await this.directory.findUsers(ids);
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = r.authUserId ? byId.get(r.authUserId) : undefined;
      return { ...r, email: u?.email ?? null, name: u?.name ?? null };
    });
  }

  private orphan(row: MemberRow): MemberView {
    return { ...row, email: null, name: null };
  }
}
