import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import {
  JobHandler,
  JobQueue,
  type JobContext,
} from '../../../core/queue/index.js';
import { ScheduledTaskService } from '../../../core/scheduler/index.js';
import { PURGE_CURSOR_START } from '../constants.js';
import { orgStateOf, transitionOrg } from '../domain/organization.js';
import { OrgPurgedEvent } from '../events.js';
import { PurgeOrgJob, PurgeOrgsJob, purgeJobId } from '../jobs.js';
import { OrgRepository } from '../ports/org-repository.js';
import { tenancySpan } from '../tenancy-telemetry.js';
import { tenancyConfig } from '../tenancy.config.js';
import { OrgPurgeParticipantRegistry } from './org-purge-participant.registry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

const PURGE_ACTOR = { type: 'system', id: 'tenancy.orgs.purge' } as const;
type PurgeResult = 'purged' | 'gone' | 'skipped';

/**
 * Spec SP3 §9.5: con trỏ keyset tăng dần (lô sau không trả lại lô trước; org purge lỗi lâu dài không chặn org sau).
 * Chạm `MAX_BATCHES` mà lô cuối vẫn đầy → WARN `org_purge_backlog`; lượt sau bắt đầu lại từ đầu (giới hạn đã biết).
 */
@Injectable()
@JobHandler(PurgeOrgsJob)
export class PurgeOrgsHandler {
  private readonly logger = new Logger(PurgeOrgsHandler.name);

  constructor(
    private readonly orgs: OrgRepository,
    private readonly queue: JobQueue,
    @Inject(tenancyConfig.KEY)
    private readonly cfg: ConfigOf<typeof tenancyConfig>,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<number> {
    let cursor = PURGE_CURSOR_START;
    let enqueued = 0;
    for (let batch = 0; batch < this.cfg.purgeMaxBatches; batch++) {
      ctx.signal.throwIfAborted();
      const due = await this.orgs.dueForPurge(cursor, this.cfg.purgeBatchSize);
      for (const orgId of due) {
        await this.queue.enqueue(
          PurgeOrgJob,
          {},
          { jobId: purgeJobId(orgId), meta: { orgId } },
        );
        enqueued += 1;
      }
      const last = due.at(-1);
      if (due.length < this.cfg.purgeBatchSize || last === undefined)
        return this.done(enqueued);
      cursor = last;
    }
    this.logger.warn(
      {
        event: 'org_purge_backlog',
        batches: this.cfg.purgeMaxBatches,
        enqueued,
      },
      'organization purge hit TENANCY_ORG_PURGE_MAX_BATCHES with a full last batch',
    );
    return enqueued;
  }

  private done(enqueued: number): number {
    this.logger.log(
      { event: 'org_purge_scan', enqueued },
      'organization purge scan finished',
    );
    return enqueued;
  }
}

/**
 * MỘT transaction trong OrgScope của job: khoá org, kiểm lại `deleted_at` + `purge_after <= clock_timestamp()` SAU
 * khoá (T-13, X-11), participant theo `order` (R-X5), rồi bảng tenancy con trước cha (tenancy core, order 1000, luôn
 * cuối), outbox `tenancy.org.purged`. Thứ tự khoá: dòng org trước mọi ghi `scheduled_tasks` (participant order 0).
 * Không còn dòng → no-op (T-14, T-26). Lỗi → metric alert + ném (BullMQ retry). Scheduler Redis gỡ SAU commit.
 */
@Injectable()
@JobHandler(PurgeOrgJob)
export class PurgeOrgHandler {
  private readonly logger = new Logger(PurgeOrgHandler.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly orgs: OrgRepository,
    private readonly participants: OrgPurgeParticipantRegistry,
    private readonly events: EventPublisher,
    private readonly schedules: ScheduledTaskService,
    private readonly metrics: TenancyMetrics,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<PurgeResult> {
    const orgId = ctx.meta.orgId;
    if (!orgId) throw new Error('tenancy.org.purge requires meta.orgId');
    let result: PurgeResult;
    try {
      result = await tenancySpan(
        'tenancy.org.purge',
        () => this.purge(orgId),
        (r) => ({ 'tenancy.purge.result': r }),
      );
    } catch (err) {
      this.metrics.orgPurgeFailed.add(1);
      this.logger.error(
        {
          event: 'org_purge_failed',
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        },
        'organization purge failed',
      );
      throw err;
    }
    this.metrics.orgPurge.add(1, { result });
    if (result === 'purged') await this.syncSchedules();
    return result;
  }

  private purge(orgId: string): Promise<PurgeResult> {
    return this.uow.run(async () => {
      const org = await this.orgs.lockCurrent();
      if (!org) return 'gone';
      const t = transitionOrg(orgStateOf(org), 'PURGE', {
        now: await this.orgs.clockNow(),
        purgeAfter: org.purgeAfter,
      });
      if (!t.ok) return 'skipped';
      for (const p of this.participants.participants())
        await p.participant.purge(orgId);
      await this.orgs.purgeCurrent();
      await this.events.publish(OrgPurgedEvent, {
        data: { orgId },
        aggregate: {
          type: 'organization',
          id: orgId,
          version: org.version + 1,
        },
        actor: PURGE_ACTOR,
      });
      return 'purged';
    });
  }

  private async syncSchedules(): Promise<void> {
    try {
      await this.schedules.syncCurrentOrg();
    } catch (err) {
      this.logger.warn(
        {
          event: 'org_schedule_sync_failed',
          after: 'purge',
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        },
        'scheduler cleanup after purge failed; the reconciler removes orphan schedulers',
      );
    }
  }
}
