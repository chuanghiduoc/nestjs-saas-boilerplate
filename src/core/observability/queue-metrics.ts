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
}
