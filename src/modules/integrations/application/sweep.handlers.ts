import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import {
  OrgSweepRunner,
  type OrgSweepResult,
} from '../../../core/sweep/index.js';
import { integrationsConfig } from '../integrations.config.js';
import { integrationsSpan } from '../integrations-telemetry.js';
import {
  DeliverWebhookJob,
  IntegrationsSweep,
  IntegrationsSweepOrgJob,
  sweptJobId,
} from '../jobs.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';
import { EndpointRepository } from '../ports/endpoint-repository.js';
import { IntegrationsMetrics } from './integrations-metrics.js';
import { LocalFailures } from './local-failures.js';

const MS_PER_SEC = 1000;

/** Cron `integrations.sweep-orgs` (queue `maintenance`): một handler mỏng, runner của core làm vòng lặp (R-X4). */
@Injectable()
@JobHandler(IntegrationsSweep.job)
export class IntegrationsSweepHandler {
  constructor(private readonly runner: OrgSweepRunner) {}
  handle(): Promise<OrgSweepResult> {
    return this.runner.run(IntegrationsSweep);
  }
}

export type SweepOrgResult = {
  requeued: number;
  leases: number;
  exhausted: number;
  purged: number;
  postponed: number;
  /** M5: secret đã hết hạn bị xoá. */
  secrets: number;
};

/**
 * Việc theo org (spec SP6 §8.3 "Sweep"; queue `webhooks-out`, `onInactiveOrg: 'run'` — I4). Một transaction, mọi claim là
 * `FOR UPDATE SKIP LOCKED` nên hai lượt song song không làm cùng một dòng; job enqueue qua outbox cùng transaction. Mỗi loại
 * việc tối đa `INTEGRATIONS_SWEEP_REQUEUE_MAX_PER_ORG` dòng mỗi lượt (M5).
 */
@Injectable()
@JobHandler(IntegrationsSweepOrgJob)
export class IntegrationsSweepOrgHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly deliveries: DeliveryRepository,
    private readonly endpoints: EndpointRepository,
    private readonly enqueue: SafeEnqueue,
    private readonly localFailures: LocalFailures,
    private readonly metrics: IntegrationsMetrics,
    @Inject(integrationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof integrationsConfig>,
  ) {}

  async handle(_ctx?: JobContext<unknown>): Promise<SweepOrgResult> {
    const r = await integrationsSpan('integrations.sweep.org', () =>
      this.uow.run(() => this.sweep()),
    );
    // Ngoài transaction: lần chạy lại của `UnitOfWork` (40001/40P01) không đếm hai lần.
    if (r.leases > 0)
      this.metrics.localFaults.add(r.leases, { reason: 'lease_expired' });
    if (r.exhausted > 0) this.metrics.exhausted.add(r.exhausted);
    return r;
  }

  private async sweep(): Promise<SweepOrgResult> {
    const grace = this.cfg.sweepGraceSec;
    const limit = this.cfg.sweepRequeueMaxPerOrg;
    // Một job mỗi cửa sổ grace: lượt sau trong cùng cửa sổ không tạo job trùng, job đã hoàn tất cùng id không nuốt job mới.
    const slot = Math.floor(Date.now() / MS_PER_SEC / grace);
    const overdue = await this.deliveries.takeOverdue(grace, limit);
    for (const d of overdue)
      await this.enqueue.enqueue(
        DeliverWebhookJob,
        { deliveryId: d.publicId },
        { jobId: sweptJobId(d.publicId, d.attemptsTotal + 1, slot) },
      );
    const leases = await this.deliveries.expiredLeases(grace, limit);
    let exhausted = 0;
    // Lỗi của ta (§7.2, R-X35): không tiêu lịch, không chạm endpoint, có đếm; CAS có fencing như mọi kết quả.
    for (const d of leases)
      if (
        (await this.localFailures.record(d, 'LEASE_EXPIRED', null)) ===
        'exhausted'
      )
        exhausted++;
    const { deleted, postponed } = await this.endpoints.purgeDue(
      limit,
      this.cfg.endpointPurgeDelaySec,
    );
    const secrets = await this.endpoints.purgeExpiredSecrets(limit);
    return {
      requeued: overdue.length,
      leases: leases.length,
      exhausted,
      purged: deleted,
      postponed,
      secrets,
    };
  }
}
