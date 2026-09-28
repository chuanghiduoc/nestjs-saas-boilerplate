import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigOf } from '../../../core/config/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { PurgeDeliveriesJob } from '../jobs.js';
import { notificationsConfig } from '../notifications.config.js';
import { DeliveryRepository } from '../ports/delivery-repository.js';

/** Xoá theo lô dòng SENT/FAILED cũ hơn `NOTIFICATIONS_RETENTION_DAYS` (mỗi câu là một transaction ngắn). */
@Injectable()
@JobHandler(PurgeDeliveriesJob)
export class PurgeDeliveriesHandler {
  private readonly logger = new Logger(PurgeDeliveriesHandler.name);

  constructor(
    private readonly repo: DeliveryRepository,
    @Inject(notificationsConfig.KEY)
    private readonly cfg: ConfigOf<typeof notificationsConfig>,
  ) {}

  async handle(ctx: JobContext<unknown>): Promise<number> {
    let total = 0;
    for (let i = 0; i < this.cfg.purgeMaxBatches; i++) {
      ctx.signal.throwIfAborted();
      const n = await this.repo.purge(
        this.cfg.retentionDays,
        this.cfg.purgeBatchSize,
      );
      total += n;
      if (n < this.cfg.purgeBatchSize) break;
    }
    this.logger.log({ deleted: total }, 'email deliveries purged');
    return total;
  }
}
