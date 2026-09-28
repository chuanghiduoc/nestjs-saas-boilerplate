import { Injectable } from '@nestjs/common';
import { metrics, type Counter } from '@opentelemetry/api';

/** Tên meter của mọi metric do core tự ghi. */
export const METER = 'core';

/**
 * Metric do chính WorkerHost ghi (sự kiện, không phải đo định kỳ). File này không import
 * `core/queue`, để `core/queue` dùng được mà không tạo vòng import. Counter tạo lúc DI khởi tạo,
 * sau khi `instrumentation.ts` đã đăng ký MeterProvider; OTel tắt thì là counter no-op.
 */
@Injectable()
export class QueueMetrics {
  private readonly failedTotal: Counter = metrics
    .getMeter(METER)
    .createCounter('queue_failed_total', {
      description: 'Failed job attempts (each retry counts)',
    });

  /** Chỉ gắn tên queue (tập nhỏ, cố định): không gắn id job/org. */
  failed(queue: string): void {
    this.failedTotal.add(1, { queue });
  }

  private readonly skippedTotal: Counter = metrics
    .getMeter(METER)
    .createCounter('queue_jobs_skipped_total', {
      description:
        'Jobs completed without running their handler (reason=org_inactive: the organization was soft-deleted or purged)',
    });

  /** Label chỉ là lý do (tập đóng), không queue/org/job. */
  skipped(reason: 'org_inactive'): void {
    this.skippedTotal.add(1, { reason });
  }
}
