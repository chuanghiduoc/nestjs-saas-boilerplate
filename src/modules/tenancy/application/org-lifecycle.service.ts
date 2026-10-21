import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork, pgFields } from '../../../core/database/index.js';
import { AppError, CoreErrors } from '../../../core/errors/index.js';
import {
  EventPublisher,
  userActor,
  type EventActor,
} from '../../../core/events/index.js';
import { ScheduledTaskService } from '../../../core/scheduler/index.js';
import { orgStateOf, transitionOrg } from '../domain/organization.js';
import { TenancyErrors } from '../errors.js';
import { OrgDeletedEvent, OrgRestoredEvent } from '../events.js';
import { InvitationRepository } from '../ports/invitation-repository.js';
import { InviteLinkRepository } from '../ports/invite-link-repository.js';
import { OrgRepository, type OrgRow } from '../ports/org-repository.js';
import { OwnershipTransferRepository } from '../ports/ownership-transfer-repository.js';
import { TenancyTestHooks } from '../ports/tenancy-test-hooks.js';
import { tenancyConfig } from '../tenancy.config.js';
import { ActorReauthorizer } from './actor-reauthorizer.js';
import { DelegationRevocations } from './delegation-revocations.js';
import { TenancyMetrics } from './tenancy-metrics.js';

/** `MEMBER`: request của user (đọc lại actor + kiểm lại cửa dưới khoá). `SYSTEM`: cron/test/migration có tên. */
export type LifecycleActor =
  { kind: 'MEMBER' } | { kind: 'SYSTEM'; id: string };

/**
 * Xoá mềm / khôi phục (spec SP3 §9.4). Chạy trong OrgScope của org (interceptor hoặc caller). Mọi ghi DB (org, lịch,
 * outbox) trong MỘT transaction đã khoá org `FOR NO KEY UPDATE`; hết hạn so bằng `clock_timestamp()` sau khoá (§3.15,
 * X-11). Thứ tự khoá (§17): dòng org LUÔN trước mọi ghi `scheduled_tasks` (treo/khôi phục lịch), nên xoá mềm không đua
 * với upsert lịch của org (trigger treo lịch đọc `deleted_at` đã commit). Khôi phục là đường DUY NHẤT gỡ treo lịch khi
 * org đang xoá mềm. Gỡ scheduler Redis chỉ SAU commit (DB-I10); lỗi ở đó chỉ WARN — reconciler
 * (`SCHEDULER_RECONCILE_CRON`) dọn.
 */
@Injectable()
export class OrgLifecycleService {
  private readonly logger = new Logger(OrgLifecycleService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
    private readonly orgs: OrgRepository,
    private readonly schedules: ScheduledTaskService,
    private readonly events: EventPublisher,
    private readonly reauth: ActorReauthorizer,
    private readonly hooks: TenancyTestHooks,
    private readonly metrics: TenancyMetrics,
    private readonly invitations: InvitationRepository,
    private readonly links: InviteLinkRepository,
    private readonly transfers: OwnershipTransferRepository,
    private readonly revocations: DelegationRevocations,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async softDelete(by: LifecycleActor): Promise<OrgRow> {
    await this.hooks.afterGuard();
    const deleted = await this.uow.run(async () => {
      const org = await this.orgs.lockCurrent();
      if (!org) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
      const actor = await this.actorFor(by, 'org.delete');
      const t = transitionOrg(orgStateOf(org), 'SOFT_DELETE', {
        now: await this.orgs.clockNow(),
        purgeAfter: org.purgeAfter,
      });
      if (!t.ok) throw new AppError(CoreErrors.NOT_FOUND, { expected: true }); // T-12: đã xoá mềm bởi request trước
      // 3C (spec §9.4, Bảng 5): thu hồi mọi link chưa thu hồi, lời mời PENDING → REVOKED, chuyển quyền PENDING → CANCELLED,
      // dưới cùng khoá org. Không event riêng (§14.1: `tenancy.org.deleted` hàm ý tất cả). Khôi phục không làm sống lại.
      // 3D: mọi key và grant chưa thu hồi (spec Bảng 5); key → 401, grant → 404 ngay, khôi phục không làm sống lại.
      await this.invitations.revokeAllPending();
      await this.links.revokeAll();
      await this.transfers.cancelAllPending();
      await this.revocations.revokeAllOfOrg();
      await this.schedules.suspendAllForCurrentOrg();
      const row = await this.orgs.softDelete(this.cfg.orgDeleteGraceSec);
      if (!row.purgeAfter)
        throw new Error(
          'soft delete returned no purge_after (organizations_deleted_pair_ck)',
        );
      await this.events.publish(OrgDeletedEvent, {
        data: { orgId: row.id, purgeAfter: row.purgeAfter.toISOString() },
        aggregate: { type: 'organization', id: row.id, version: row.version },
        actor,
      });
      return row;
    });
    await this.syncSchedules('soft_delete');
    return deleted;
  }

  async restore(by: LifecycleActor): Promise<OrgRow> {
    await this.hooks.afterGuard();
    let restored: OrgRow;
    try {
      restored = await this.uow.run(async () => {
        const org = await this.orgs.lockCurrent();
        if (!org) throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
        const actor = await this.actorFor(by, 'org.restore');
        const t = transitionOrg(orgStateOf(org), 'RESTORE', {
          now: await this.orgs.clockNow(),
          purgeAfter: org.purgeAfter,
        });
        if (!t.ok) {
          switch (t.reason) {
            case 'NOT_DELETED':
              throw new AppError(TenancyErrors.ORG_NOT_DELETED);
            case 'GRACE_EXPIRED':
            case 'NOT_ACTIVE':
            case 'NOT_DUE':
              throw new AppError(CoreErrors.NOT_FOUND, { expected: true });
            default: {
              const unknown: never = t.reason;
              throw new Error(`unknown restore refusal ${String(unknown)}`);
            }
          }
        }
        await this.schedules.resumeAllForCurrentOrg();
        const row = await this.orgs.restore();
        await this.events.publish(OrgRestoredEvent, {
          data: { orgId: row.id },
          aggregate: { type: 'organization', id: row.id, version: row.version },
          actor,
        });
        return row;
      });
    } catch (err) {
      // Trigger hoãn `organizations_restore_owner_ck` bắn lúc COMMIT (O-14): 409 last_owner qua constraint map.
      if (pgFields(err)?.constraint === 'organizations_restore_owner_ck')
        this.metrics.lastOwnerBlocked.add(1, { path: 'restore' });
      throw err;
    }
    await this.syncSchedules('restore');
    return restored;
  }

  private async actorFor(by: LifecycleActor, key: string): Promise<EventActor> {
    switch (by.kind) {
      case 'MEMBER':
        await this.reauth.require([key]);
        return userActor(this.ctx, 'tenancy');
      case 'SYSTEM':
        return { type: 'system', id: by.id };
      default: {
        const unknown: never = by;
        throw new Error(`unknown lifecycle actor ${JSON.stringify(unknown)}`);
      }
    }
  }

  private async syncSchedules(after: 'soft_delete' | 'restore'): Promise<void> {
    try {
      await this.schedules.syncCurrentOrg();
    } catch (err) {
      this.logger.warn(
        {
          event: 'org_schedule_sync_failed',
          after,
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        },
        'scheduler sync after an org lifecycle change failed; the schedule reconciler will converge it',
      );
    }
  }
}
