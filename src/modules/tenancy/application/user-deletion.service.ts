import { Injectable, Logger } from '@nestjs/common';
import {
  OrgScope,
  UnitOfWork,
  pgFields,
} from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import {
  UserDeletionGuard,
  type UserDeletionCheck,
  type UserDeletionRelease,
} from '../../identity/index.js';
import { MemberRemovedEvent } from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

const DELETION_ACTOR = {
  type: 'system',
  id: 'identity.user-deletion',
} as const;
const LAST_OWNER_CONSTRAINT = 'org_members_last_owner_ck';
const MEMBERSHIP_FK = 'org_members_user_fk';
const RESTRICT_VIOLATION = '23001';

/**
 * Spec SP3 §9.6 (chỉ `local`/`hybrid`; `external` không có hook). `check` chạy ở `hooks.before` (chưa xoá gì); `release`
 * ở `databaseHooks.user.delete.before` (session/account đã bị Better Auth xoá). Cả hai trả kết quả có tên, không ném
 * `AppError` (hook đổi lỗi lạ thành 500). Mỗi org một transaction (OrgScope không đổi org giữa transaction), theo
 * `org_id` tăng dần; dừng ở kết quả khác `RELEASED` đầu tiên (runbook §9.6).
 *
 * `release` không bao giờ TẠO dòng tenancy (`find`, không upsert): user chưa từng chạm tenancy → `RELEASED`, no-op.
 * Hai `release` song song của cùng user (hai admin cùng xoá) an toàn: mỗi org được khoá `FOR NO KEY UPDATE` trước khi
 * đọc membership, nên đúng một bên xoá member và phát event, bên kia đọc lại dưới khoá và không thấy gì; `DELETE` dòng
 * `tenancy_users` đã mất là 0 dòng, không lỗi. Thứ tự khoá: org → (member); dòng `tenancy_users` xoá ở transaction
 * riêng, không giữ khoá org nào.
 */
@Injectable()
export class UserDeletionService extends UserDeletionGuard {
  private readonly logger = new Logger(UserDeletionService.name);

  constructor(
    private readonly scope: OrgScope,
    private readonly uow: UnitOfWork,
    private readonly users: TenancyUserRepository,
    private readonly orgs: OrgRepository,
    private readonly members: MemberRepository,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    private readonly metrics: TenancyMetrics,
  ) {
    super();
  }

  check(authUserId: string): Promise<UserDeletionCheck> {
    return tenancySpan(
      'tenancy.user_deletion.check',
      async (): Promise<UserDeletionCheck> => {
        const user = await this.users.find({ kind: 'AUTH_USER', authUserId });
        if (!user) return { kind: 'ALLOWED' };
        const sole = await this.orgs.soleOwnerOrgs(user.id);
        if (sole.length === 0) return { kind: 'ALLOWED' };
        this.metrics.lastOwnerBlocked.add(1, { path: 'account_delete' });
        return { kind: 'BLOCKED_LAST_OWNER', orgCount: sole.length };
      },
      (r) => ({ 'tenancy.user_deletion.result': r.kind }),
    );
  }

  release(authUserId: string): Promise<UserDeletionRelease> {
    return tenancySpan(
      'tenancy.user_deletion.release',
      () => this.releaseAll(authUserId),
      (r) => ({ 'tenancy.user_deletion.result': r.kind }),
    );
  }

  private async releaseAll(authUserId: string): Promise<UserDeletionRelease> {
    const user = await this.users.find({ kind: 'AUTH_USER', authUserId });
    if (!user) return { kind: 'RELEASED' };
    for (const orgId of await this.orgs.relatedOrgIds(user.id)) {
      await this.hooks.beforeRelease(authUserId, orgId);
      const blocked = await this.releaseOrg(orgId, user.id);
      if (blocked) return blocked;
    }
    try {
      // Bảng global, không OrgScope. `created_by_user_id` đã NULL ở từng org nên SET NULL của FK không khoá org nào (T-24).
      await this.uow.run(() => this.users.deleteById(user.id));
    } catch (err) {
      const pg = pgFields(err);
      if (
        pg?.sqlState === RESTRICT_VIOLATION &&
        pg.constraint === MEMBERSHIP_FK
      ) {
        this.logger.warn(
          { event: 'user_deletion_blocked_race', reason: 'MEMBERSHIP_CREATED' },
          'a membership was created while the account was being deleted',
        );
        return { kind: 'BLOCKED_RACE', reason: 'MEMBERSHIP_CREATED' };
      }
      throw err;
    }
    return { kind: 'RELEASED' };
  }

  /** Một org: khoá org → gỡ tham chiếu người tạo DƯỚI khoá → xoá membership + event. Org đã mất (purge, T-26) → bỏ qua. */
  private async releaseOrg(
    orgId: string,
    userId: string,
  ): Promise<UserDeletionRelease | undefined> {
    try {
      await this.scope.run(orgId, () =>
        this.uow.run(async () => {
          if (!(await this.orgs.lockCurrent())) return;
          await this.orgs.detachCreator(userId);
          const member = await this.members.findByUserId(userId);
          if (!member) return;
          // 3C: huỷ chuyển quyền PENDING của member; 3D: đọc key của member để phát `api_key.revoked` (spec Bảng 5).
          await this.members.deleteById(member.id);
          await this.events.publish(MemberRemovedEvent, {
            data: {
              memberId: member.publicId,
              userId: member.userPublicId,
              roleId: member.rolePublicId,
              reason: 'ACCOUNT_DELETED',
            },
            aggregate: {
              type: 'member',
              id: member.publicId,
              version: member.version + 1,
            },
            actor: DELETION_ACTOR,
          });
        }),
      );
      return undefined;
    } catch (err) {
      if (pgFields(err)?.constraint !== LAST_OWNER_CONSTRAINT) throw err;
      this.metrics.lastOwnerBlocked.add(1, { path: 'account_delete' });
      this.logger.warn(
        { event: 'user_deletion_blocked_race', reason: 'LAST_OWNER' },
        'the account became the last owner of an organization during deletion',
      );
      return { kind: 'BLOCKED_RACE', reason: 'LAST_OWNER' };
    }
  }
}
