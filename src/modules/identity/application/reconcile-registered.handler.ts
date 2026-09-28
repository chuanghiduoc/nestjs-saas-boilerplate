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
  async handle(ctx: JobContext<unknown>): Promise<{ processed: number }> {
    return identitySpan(
      'identity.registered.reconcile',
      () => this.reconcile(ctx),
      (r) => ({ 'identity.reconcile.processed': r.processed }),
    );
  }

  /**
   * review I1: đo gauge độc lập với kết quả của batch, trong `finally`. Nếu không, một outbox hay auth
   * pool nghẽn dài (chính là điều gauge phải báo) làm `reconcile` luôn throw trước khi tới phép đo, và
   * gauge đứng yên ở giá trị tốt cuối cùng suốt cả outage. Lỗi đo (auth pool cũng down) được log riêng,
   * không nuốt lỗi gốc của batch (rethrow nguyên vẹn).
   */
  private async reconcile(
    ctx: JobContext<unknown>,
  ): Promise<{ processed: number }> {
    const { ledger, service } = this;
    if (!ledger || !service) {
      this.logger.debug(
        'Registered event reconciliation skipped: auth providers unavailable',
      );
      return { processed: 0 };
    }
    // "processed" (review M8): số id mà batch này gửi lại publish, không phải số dòng outbox mới thật.
    // `ifAbsent` biến id đã có event thành no-op; đếm insert thật cần OutboxWriter trả về kết quả insert,
    // một thay đổi ngoài phạm vi Task 32 (EventPublisher/OutboxWriter dùng chung nhiều module khác).
    let processed = 0;
    try {
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
        processed += ids.length;
        if (ids.length < this.cfg.registeredReconcileBatchSize) break;
      }
      return { processed };
    } finally {
      try {
        this.oldestSec = (await ledger.oldestUnmarkedAgeSec()) ?? 0;
        this.logger.log(
          { processed, oldestUnmarkedSec: this.oldestSec },
          'registered events reconciled',
        );
      } catch (measureErr) {
        this.logger.error(
          { err: measureErr },
          'failed to measure the registered-event backlog age',
        );
      }
    }
  }
}
