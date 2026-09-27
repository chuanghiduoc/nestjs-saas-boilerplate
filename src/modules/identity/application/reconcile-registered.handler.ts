import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { type ConfigOf } from '../../../core/config/index.js';
import { IDENTITY_METER, identitySpan } from '../identity-telemetry.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { identityGuardConfig } from '../identity.config.js';
import { ReconcileRegisteredJob } from '../jobs.js';
import { RegistrationLedger } from '../ports/registration-ledger.js';
import { RegisteredEventService } from './registered-event.service.js';

/**
 * Bù event cho user chưa có marker (spec §5.10): không có giới hạn cửa sổ thời gian, nên user commit muộn
 * hay worker dừng lâu vẫn được tìm thấy. `GRACE` chỉ để after-hook chạy trước. Ở `AUTH_MODE=external` không
 * có pool auth: handler vẫn được đăng ký (cron tĩnh của maintenance queue cần handler) và không làm gì.
 */
@Injectable()
@JobHandler(ReconcileRegisteredJob)
export class ReconcileRegisteredHandler implements OnModuleDestroy {
  private readonly logger = new Logger(ReconcileRegisteredHandler.name);
  private oldestSec: number | null = null;

  constructor(
    private readonly uow: UnitOfWork,
    @Inject(identityGuardConfig.KEY)
    private readonly cfg: ConfigOf<typeof identityGuardConfig>,
    @Optional() private readonly ledger?: RegistrationLedger,
    @Optional() private readonly service?: RegisteredEventService,
  ) {
    this.gauge.addCallback(this.observe);
  }

  private readonly gauge = metrics
    .getMeter(IDENTITY_METER)
    .createObservableGauge('identity_registered_unmarked_oldest_seconds', {
      description:
        'Age of the oldest user whose registered event is not marked yet',
      unit: 's',
    });
  private readonly observe = (r: ObservableResult): void => {
    if (this.oldestSec !== null) r.observe(this.oldestSec);
  };

  onModuleDestroy(): void {
    this.gauge.removeCallback(this.observe);
  }

  /** Span `identity.registered.reconcile` (review I8), con của span job của SP1; attribute chỉ là số đếm. */
  async handle(ctx: JobContext<unknown>): Promise<{ published: number }> {
    return identitySpan(
      'identity.registered.reconcile',
      () => this.reconcile(ctx),
      (r) => ({ 'identity.reconcile.published': r.published }),
    );
  }

  private async reconcile(
    ctx: JobContext<unknown>,
  ): Promise<{ published: number }> {
    const { ledger, service } = this;
    if (!ledger || !service) {
      this.logger.debug(
        'Registered event reconciliation skipped: auth providers unavailable',
      );
      return { published: 0 };
    }
    let published = 0;
    for (let i = 0; i < this.cfg.registeredReconcileMaxBatches; i++) {
      ctx.signal.throwIfAborted();
      const ids = await ledger.unmarked(
        this.cfg.registeredReconcileGraceSec,
        this.cfg.registeredReconcileBatchSize,
      );
      if (ids.length === 0) break;
      // Stable lock order prevents overlapping batches from deadlocking on outbox uniqueness.
      await this.uow.run(async () => {
        for (const id of [...ids].sort()) {
          ctx.signal.throwIfAborted();
          await service.publish(id);
        }
      });
      await ledger.mark(ids);
      published += ids.length;
      if (ids.length < this.cfg.registeredReconcileBatchSize) break;
    }
    this.oldestSec = await ledger.oldestUnmarkedAgeSec();
    this.logger.log(
      { published, oldestUnmarkedSec: this.oldestSec },
      'registered events reconciled',
    );
    return { published };
  }
}
