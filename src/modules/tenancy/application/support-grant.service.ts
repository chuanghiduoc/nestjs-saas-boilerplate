import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import { EventPublisher, userActor } from '../../../core/events/index.js';
import {
  IdentityDirectory,
  hasAdminRole,
  isBanned,
} from '../../identity/index.js';
import { supportPreset } from '../domain/delegation.js';
import { TenancyErrors } from '../errors.js';
import { SupportAccessGrantedEvent } from '../events.js';
import { MemberRepository } from '../ports/member-repository.js';
import { OrgRepository } from '../ports/org-repository.js';
import {
  SupportGrantRepository,
  type SupportGrantRow,
} from '../ports/support-grant-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { TenancyUserRepository } from '../ports/tenancy-user-repository.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer } from './actor-reauthorizer.js';
import { DelegationRevocations } from './delegation-revocations.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyFeatures } from './tenancy-features.js';
import { lockAdmittedUser } from './tenancy-user-lock.js';

const GRANT = 'support_access.grant';
/** Spec §9.7: một mã cho mọi lý do (không phải nhân viên, chưa 2FA, bị ban, là member, không tồn tại). */
const ineligible = () => new AppError(TenancyErrors.SUPPORT_GRANTEE_INELIGIBLE);
const notFound = () => new AppError(CoreErrors.NOT_FOUND, { expected: true });

/**
 * Support grant (spec SP3 §9.7, S3-Q6, PR19, PR21). Điều kiện người nhận đọc trên pool auth NGOÀI transaction của pool app
 * (§3 Truy cập SQL); dưới khoá org chỉ còn "không phải member" (trigger hoãn definer là lớp chặn cuối, T-19) — upsert
 * `tenancy_users` chỉ sau khi mọi điều kiện đạt (SEC-I9, S-13). Một grant mở mỗi người nhận: cấp lại thu hồi grant cũ (T-20,
 * partial UNIQUE là lớp cuối). Đua với ghi role nền tảng (T-40): grant chèn sau lượt thu hồi vô dụng khi người nhận không còn là
 * nhân viên (middleware đòi `isPlatformAdmin()` mỗi request) và bị thu hồi ở lần ghi role kế tiếp.
 */
@Injectable()
export class SupportGrantService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly users: TenancyUserRepository,
    private readonly members: MemberRepository,
    private readonly grants: SupportGrantRepository,
    private readonly revocations: DelegationRevocations,
    private readonly reauth: ActorReauthorizer,
    private readonly registry: PermissionCatalogueRegistry,
    private readonly features: TenancyFeatures,
    private readonly events: EventPublisher,
    private readonly hooks: TenancyTestHooks,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
    @Optional() private readonly directory?: IdentityDirectory,
  ) {}

  async grant(i: {
    staffUserId: string;
    expiresInSec: number;
    reason: string;
  }): Promise<SupportGrantRow> {
    // Ở `external`, cờ luôn tắt (Task 16) nên ném ở đây trước khi đọc directory.
    this.features.require('supportGrants');
    if (i.expiresInSec > this.cfg.supportGrantMaxTtlSec)
      throw new AppError(TenancyErrors.TTL_OUT_OF_RANGE);
    if (!this.directory)
      throw new Error('support grants are enabled without IdentityDirectory');
    const staff = await this.directory.findUser(i.staffUserId);
    if (
      !staff ||
      !hasAdminRole(staff.role) ||
      !staff.twoFactorEnabled ||
      isBanned(staff, new Date())
    )
      throw ineligible();
    const preset = supportPreset(this.registry.merged());
    if (preset.length === 0)
      throw new Error(
        'the merged catalogue has no support-eligible read permission',
      );
    await this.hooks.afterGuard();
    return this.uow.run(async () => {
      await this.lockActiveOrg();
      const { actor } = await this.reauth.require([GRANT]);
      // `staffUserId` là id `auth."user"` nên subject là `AUTH_USER`; tài khoản đang bị xoá → 409 (như lời mời, join).
      const grantee = await lockAdmittedUser(this.users, {
        kind: 'AUTH_USER',
        authUserId: staff.id,
      });
      if (await this.members.findByUserId(grantee.id)) throw ineligible(); // rollback cả upsert (S-13)
      const by = userActor(this.ctx, 'tenancy');
      await this.revocations.revokeGrantsOfGrantee(grantee.id, 'REVOKED', by);
      const g = await this.grants.insert({
        granteeUserId: grantee.id,
        grantedByMemberId: actor.id,
        reason: i.reason,
        expiresInSec: i.expiresInSec,
        permissions: preset,
      });
      await this.events.publish(SupportAccessGrantedEvent, {
        data: {
          grantId: g.publicId,
          granteeUserId: g.granteeUserPublicId,
          grantedByMemberId: g.grantedByMemberPublicId,
          permissions: g.permissions,
          expiresAt: g.expiresAt.toISOString(),
        },
        aggregate: {
          type: 'support_grant',
          id: g.publicId,
          version: g.version,
        },
        actor: by,
      });
      return g;
    });
  }

  async list(q: {
    page: number;
    pageSize: number;
    cap: number;
  }): Promise<{ rows: SupportGrantRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.grants.list({
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
      }),
      this.grants.countUpTo(q.cap),
    ]);
    return { rows, total };
  }

  /** Thu hồi chạy được cả khi tính năng tắt (đóng cửa luôn phải làm được). Đã thu hồi → no-op. */
  async revoke(publicId: string): Promise<void> {
    await this.hooks.afterGuard();
    await this.uow.run(async () => {
      await this.lockActiveOrg();
      await this.reauth.require([GRANT]);
      const g = await this.grants.lockByPublicId(publicId);
      if (!g) throw notFound();
      const done = await this.grants.revoke(g.id);
      if (done)
        await this.revocations.publishGrantRevoked(
          done,
          'REVOKED',
          userActor(this.ctx, 'tenancy'),
        );
    });
  }

  private async lockActiveOrg(): Promise<void> {
    const org = await this.orgs.lockCurrent();
    if (!org || org.deletedAt) throw notFound();
  }
}
