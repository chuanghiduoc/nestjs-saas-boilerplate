import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { type ConfigOf } from '../../../core/config/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { EventPublisher } from '../../../core/events/index.js';
import { SafeEnqueue } from '../../../core/outbox/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { DeliveryFailedEvent } from '../events.js';
import {
  ReconcileDeliveriesJob,
  SendEmailJob,
  sendEmailJobId,
} from '../jobs.js';
import { notificationsConfig } from '../notifications.config.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';

/**
 * Đối soát thư kẹt (spec §5.11): PENDING, hoặc SENDING hết lease, và đã qua thời gian chờ kể từ lần enqueue
 * trước. Thời gian chờ nằm trong câu UPDATE atomic (`bumpGeneration`): hai cron song song thì chỉ một cron
 * qua được điều kiện và enqueue; jobId `<public_id>-g<generation>` luôn mới nên BullMQ không bỏ qua.
 */
@Injectable()
@JobHandler(ReconcileDeliveriesJob)
export class ReconcileDeliveriesHandler {
  private readonly logger = new Logger(ReconcileDeliveriesHandler.name);
  private readonly stuck = metrics
    .getMeter('notifications')
    .createCounter('notifications_email_stuck_total', {
      description: 'Stuck deliveries found by the reconcile cron',
    });

  constructor(
    private readonly repo: DeliveryRepository,
    private readonly uow: UnitOfWork,
    private readonly enqueue: SafeEnqueue,
    private readonly events: EventPublisher,
    @Inject(notificationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof notificationsConfig>,
  ) {}

  async handle(
    ctx: JobContext<unknown>,
  ): Promise<{ requeued: number; failed: number }> {
    const rows = await this.repo.findStale(
      this.cfg.reenqueueCooldownSec,
      this.cfg.reconcileBatchSize,
    );
    this.stuck.add(rows.length);
    let requeued = 0;
    let failed = 0;
    for (const row of rows) {
      ctx.signal.throwIfAborted();
      await this.uow.run(async () => {
        if (row.attempts >= this.cfg.maxTotalAttempts) {
          const template = await this.repo.failExhausted(
            row.publicId,
            this.cfg.maxTotalAttempts,
          );
          if (!template) return;
          await this.events.publish(DeliveryFailedEvent, {
            data: {
              deliveryId: row.publicId,
              template,
              errorCode: 'ATTEMPTS_EXHAUSTED',
            },
            aggregate: { type: 'email_delivery', id: row.publicId, version: 1 },
            actor: { type: 'system', id: 'notifications' },
          });
          failed++;
          return;
        }
        const generation = await this.repo.bumpGeneration(
          row.publicId,
          this.cfg.reenqueueCooldownSec,
        );
        if (generation === undefined) return;
        await this.enqueue.enqueue(
          SendEmailJob,
          { deliveryId: row.publicId },
          { jobId: sendEmailJobId(row.publicId, generation) },
        );
        requeued++;
      });
    }
    this.logger.log({ requeued, failed }, 'email deliveries reconciled');
    return { requeued, failed };
  }
}
