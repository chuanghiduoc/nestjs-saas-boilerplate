import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { type ConfigOf } from '../../../core/config/index.js';
import { JobHandler, type JobContext } from '../../../core/queue/index.js';
import { identityGuardConfig } from '../identity.config.js';
import {
  IDENTITY_METER,
  identitySpan,
  safeErrorFields,
} from '../identity-telemetry.js';
import { ReconcileSecurityNoticesJob } from '../jobs.js';
import { SecurityNoticeLedger } from '../ports/security-notice-ledger.js';
import { SecurityNoticeService } from './security-notice.service.js';

/** Một hay nhiều marker gửi lỗi trong lần chạy này; chúng vẫn chưa gửi và được thử lại ở lần chạy sau. */
export class SecurityNoticeReconcileError extends Error {
  constructor(readonly failed: number) {
    super(
      `${failed} security notice(s) could not be requested; left pending for the next run`,
    );
  }
}

/**
 * Lưới an toàn của thông báo bảo mật (S2-R75): gửi mọi marker chưa gửi cũ hơn `GRACE` (đường gửi nhanh chạy trước).
 * Không có cận dưới thời gian, nên marker commit muộn hay worker dừng lâu vẫn được gửi. Trùng với đường gửi nhanh hay một
 * cron song song không sinh thư thứ hai: key của thư là marker. Một marker lỗi không chặn các marker khác trong batch; lần
 * chạy vẫn thất bại (job lỗi, log ERROR) để lỗi không bị nuốt. Ở `AUTH_MODE=external` không có pool auth: handler vẫn được
 * đăng ký (cron tĩnh của maintenance queue cần handler) và không làm gì.
 */
@Injectable()
@JobHandler(ReconcileSecurityNoticesJob)
export class ReconcileSecurityNoticesHandler implements OnModuleDestroy {
  private readonly logger = new Logger(ReconcileSecurityNoticesHandler.name);
  private oldestSec: number | null = null;

  constructor(
    @Inject(identityGuardConfig.KEY)
    private readonly cfg: ConfigOf<typeof identityGuardConfig>,
    @Optional() private readonly ledger?: SecurityNoticeLedger,
    @Optional() private readonly service?: SecurityNoticeService,
  ) {
    this.gauge.addCallback(this.observe);
  }

  private readonly gauge = metrics
    .getMeter(IDENTITY_METER)
    .createObservableGauge('identity_security_notice_pending_oldest_seconds', {
      description:
        'Age of the oldest security notice (e.g. 2FA changed) not requested yet',
      unit: 's',
    });
  private readonly observe = (r: ObservableResult): void => {
    if (this.oldestSec !== null) r.observe(this.oldestSec);
  };

  onModuleDestroy(): void {
    this.gauge.removeCallback(this.observe);
  }

  async handle(ctx: JobContext<unknown>): Promise<{ processed: number }> {
    return identitySpan(
      'identity.security_notice.reconcile',
      () => this.reconcile(ctx),
      (r) => ({ 'identity.reconcile.processed': r.processed }),
    );
  }

  /** Gauge đo trong `finally`, độc lập với kết quả batch (cùng lý do với `ReconcileRegisteredHandler`, review I1). */
  private async reconcile(
    ctx: JobContext<unknown>,
  ): Promise<{ processed: number }> {
    const { ledger, service } = this;
    if (!ledger || !service) {
      this.logger.debug(
        'Security notice reconciliation skipped: auth providers unavailable',
      );
      return { processed: 0 };
    }
    let processed = 0;
    let failed = 0;
    try {
      for (let i = 0; i < this.cfg.securityNoticeReconcileMaxBatches; i++) {
        ctx.signal.throwIfAborted();
        const batch = await ledger.pending(
          this.cfg.securityNoticeReconcileGraceSec,
          this.cfg.securityNoticeReconcileBatchSize,
        );
        for (const notice of batch) {
          ctx.signal.throwIfAborted();
          try {
            await service.deliver(notice);
            processed++;
          } catch (err) {
            failed++;
            this.logger.error(
              {
                event: 'security_notice_reconcile_failed',
                noticeId: notice.id,
                userId: notice.userId,
                ...safeErrorFields(err),
              },
              'security notice could not be requested; retried on the next run',
            );
          }
        }
        // Marker lỗi vẫn chưa gửi: lấy batch tiếp sẽ đọc lại chính chúng, nên dừng ở đây và để lần chạy sau thử lại.
        if (failed > 0) throw new SecurityNoticeReconcileError(failed);
        if (batch.length < this.cfg.securityNoticeReconcileBatchSize) break;
      }
      return { processed };
    } finally {
      try {
        this.oldestSec = (await ledger.oldestPendingAgeSec()) ?? 0;
        this.logger.log(
          { processed, failed, oldestPendingSec: this.oldestSec },
          'security notices reconciled',
        );
      } catch (measureErr) {
        this.logger.error(
          {
            event: 'security_notice_backlog_measure_failed',
            ...safeErrorFields(measureErr),
          },
          'failed to measure the security notice backlog age',
        );
      }
    }
  }
}
